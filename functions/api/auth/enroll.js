// POST /api/auth/enroll  { code } -> { token, username, roles } + Session-Cookie
//
// Ersteinrichtung eines Geräts: der Einmal-Code aus dem QR wird gegen einen
// langlebigen Device-Token getauscht. Der Token entsteht erst hier und wandert
// direkt auf das Gerät — er steht nie in einer Mail, einem Chat oder auf einem
// Zettel. Der Code ist 15 Minuten gültig und genau einmal einlösbar.
//
// Ein neuer Token macht den alten ungültig und beendet alle bestehenden
// Sessions des Geräts — damit ist ein ausgetauschtes oder neu aufgesetztes
// Tablet automatisch der einzige gültige Zugang (1 Gerät je Geräte-Benutzer).
import {
  sha256Hex,
  newDeviceToken,
  createSession,
  buildSessionCookie,
  deleteSessionsForUser,
  touchDeviceSeen,
  json,
  err,
  forbidden,
  isEpMember,
} from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return err('D1 not bound', 500);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const code = String(body?.code || '').trim();
  const ungueltig = () => err('Dieser Einrichtungs-Code ist ungültig', 401);
  if (!code) return ungueltig();

  const codeHash = await sha256Hex(code);
  const row = await env.DB.prepare(
    `SELECT e.user_id, e.expires_at, e.used_at, u.username, u.is_device
     FROM device_enrollments e
     JOIN users u ON u.id = e.user_id
     WHERE e.code_hash = ?`
  ).bind(codeHash).first();

  if (!row || !row.is_device) return ungueltig();
  if (row.used_at) return err('Dieser Einrichtungs-Code wurde bereits verwendet', 410);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return err('Dieser Einrichtungs-Code ist abgelaufen', 410);
  }

  const rolesRes = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE user_id = ?`
  ).bind(row.user_id).all();
  const roles = rolesRes.results.map((r) => r.role);
  if (!isEpMember({ roles })) return forbidden();

  const token = newDeviceToken();
  const tokenHash = await sha256Hex(token);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users
         SET device_token_hash = ?, device_token_prefix = ?, device_revoked_at = NULL
       WHERE id = ?`
    ).bind(tokenHash, token.slice(0, 8), row.user_id),
    env.DB.prepare(
      `UPDATE device_enrollments SET used_at = CURRENT_TIMESTAMP WHERE code_hash = ?`
    ).bind(codeHash),
  ]);

  // Alter Token ist ab jetzt wertlos — bestehende Sessions mit beenden.
  await deleteSessionsForUser(env, row.user_id).catch(() => {});

  const sess = await createSession(env, row.user_id, { isDevice: true });
  await touchDeviceSeen(env, row.user_id, request).catch(() => {});
  const cookie = buildSessionCookie(sess.token, request, sess.maxAge);

  return json(
    { token, username: row.username, roles, is_device: true },
    { headers: { 'Set-Cookie': cookie } }
  );
}
