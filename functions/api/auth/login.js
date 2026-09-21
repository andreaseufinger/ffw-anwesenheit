// POST /api/auth/login  { username, password } -> setzt Session-Cookie
// Erfolgreich nur, wenn der Benutzer mindestens eine Rolle für diese App hat.
import {
  verifyPassword,
  createSession,
  buildSessionCookie,
  json,
  err,
  unauthorized,
  forbidden,
  APP_ROLES,
} from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return err('D1 not bound', 500);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  if (!username || !password) return err('Benutzername und Passwort erforderlich');

  const user = await env.DB.prepare(
    `SELECT id, username, password_hash, password_salt FROM users WHERE username = ? COLLATE NOCASE`
  ).bind(username).first();
  if (!user) return unauthorized();

  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) return unauthorized();

  const rolesRes = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE user_id = ?`
  ).bind(user.id).all();
  const roles = rolesRes.results.map((r) => r.role);

  // Diese App nur betreten, wenn mindestens eine App-Rolle vorliegt.
  if (!roles.includes(APP_ROLES.ADMIN) && !roles.includes(APP_ROLES.ERFASSER)) {
    return forbidden();
  }

  const sess = await createSession(env, user.id);
  const cookie = buildSessionCookie(sess.token, request, sess.maxAge);

  return json(
    { username: user.username, roles },
    { headers: { 'Set-Cookie': cookie } }
  );
}
