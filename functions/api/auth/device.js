// POST /api/auth/device  { token } -> setzt Session-Cookie
//
// Stille Wiederanmeldung eines Geräte-Benutzers (LF10, GW). Das Frontend ruft
// diesen Endpunkt nur, wenn /api/auth/me 401 liefert — also wenn das
// Session-Cookie abgelaufen ist oder der Browser es verworfen hat (auf iOS
// räumt ITP Cookies bei längerer Inaktivität ab). Der Device-Token liegt dafür
// im localStorage des Geräts.
//
// Persönliche Benutzer können diesen Weg nicht nutzen: es werden nur Zeilen
// mit is_device = 1 gefunden.
import {
  sha256Hex,
  createSession,
  buildSessionCookie,
  touchDeviceSeen,
  json,
  err,
  unauthorized,
  forbidden,
  isEpMember,
} from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return err('D1 not bound', 500);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const token = String(body?.token || '').trim();
  if (!token) return unauthorized();

  // Vergleich über den Hash: der Token selbst steht nirgends in der Datenbank.
  const tokenHash = await sha256Hex(token);
  const user = await env.DB.prepare(
    `SELECT id, username, device_revoked_at
     FROM users
     WHERE is_device = 1 AND device_token_hash = ?`
  ).bind(tokenHash).first();
  if (!user) return unauthorized();
  if (user.device_revoked_at) return forbidden();

  const rolesRes = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE user_id = ?`
  ).bind(user.id).all();
  const roles = rolesRes.results.map((r) => r.role);
  if (!isEpMember({ roles })) return forbidden();

  const sess = await createSession(env, user.id, { isDevice: true });
  await touchDeviceSeen(env, user.id, request).catch(() => {});
  const cookie = buildSessionCookie(sess.token, request, sess.maxAge);

  return json(
    { username: user.username, roles, is_device: true },
    { headers: { 'Set-Cookie': cookie } }
  );
}
