// POST /api/auth/login  { username, password } -> setzt Session-Cookie
// Erfolgreich nur, wenn der Benutzer mindestens eine Rolle in der Anwesenheit
// oder im Einsatzprotokoll hat. Eine Anmeldung gilt für beide Bereiche; was
// er dort darf, entscheiden die Rollen (zugang.js).
//
// Nach zu vielen Fehlversuchen für einen Benutzernamen oder eine Adresse
// antwortet der Endpunkt 429, ohne das Passwort zu prüfen (SEC3).
import {
  verifyPassword,
  createSession,
  buildSessionCookie,
  json,
  err,
  unauthorized,
  forbidden,
  isAppMember,
  isEpMember,
  anfrageIp,
  loginGesperrt,
  loginFehlschlag,
  loginErfolg,
  zuVieleVersuche,
  passwortPruefenOhneKonto,
} from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return err('D1 not bound', 500);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  if (!username || !password) return err('Benutzername und Passwort erforderlich');

  const ip = anfrageIp(request);
  if (await loginGesperrt(env, username, ip)) return zuVieleVersuche();

  const user = await env.DB.prepare(
    `SELECT id, username, password_hash, password_salt, is_device
     FROM users WHERE username = ? COLLATE NOCASE`
  ).bind(username).first();

  // Geräte-Benutzer (Fahrzeug-Tablets) haben kein nutzbares Passwort — sie
  // melden sich ausschließlich über /api/auth/device mit ihrem Device-Token an.
  const ok = user && !user.is_device
    ? await verifyPassword(password, user.password_hash, user.password_salt)
    : await passwortPruefenOhneKonto(password);
  if (!ok) {
    await loginFehlschlag(env, username, ip);
    return unauthorized();
  }

  const rolesRes = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE user_id = ?`
  ).bind(user.id).all();
  const roles = rolesRes.results.map((r) => r.role);

  // Nur mit mindestens einer Rolle in einem der beiden Bereiche. Über
  // isAppMember/isEpMember und nicht inline, damit es EINE Stelle gibt, die
  // das entscheidet — die inline-Variante hatte den Abteilungsadmin übersehen.
  if (!isAppMember({ roles }) && !isEpMember({ roles })) return forbidden();

  await loginErfolg(env, user.username);
  const sess = await createSession(env, user.id);
  const cookie = buildSessionCookie(sess.token, request, sess.maxAge);

  return json(
    { username: user.username, roles },
    { headers: { 'Set-Cookie': cookie } }
  );
}
