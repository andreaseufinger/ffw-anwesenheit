// POST /api/auth/passwort  { alt, neu } — eigenes Passwort ändern (SEC3)
//
// Vorher konnte niemand sein eigenes Passwort ändern; der Admin vergab und
// kannte alle. Das alte Passwort muss stimmen; Fehlversuche zählen wie beim
// Login. Andere Sitzungen des Kontos werden beendet, die eigene bleibt.
// Geräte haben kein Passwort und kommen hier nicht an (keine Rolle in der
// Anwesenheit, siehe _lib/zugang.js).
import {
  json, err, unauthorized, verifyPassword, createPasswordHash, validatePassword,
  sitzungenBeenden, anfrageIp, loginGesperrt, loginFehlschlag, loginErfolg, zuVieleVersuche,
} from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const alt = String(body?.alt || '');
  const neu = body?.neu;
  if (!alt) return err('Bisheriges Passwort fehlt');
  const fehler = validatePassword(neu); if (fehler) return err(fehler);
  if (neu === alt) return err('Das neue Passwort muss sich vom bisherigen unterscheiden');

  const ip = anfrageIp(request);
  if (await loginGesperrt(env, data.user.username, ip)) return zuVieleVersuche();

  const konto = await env.DB.prepare(
    `SELECT id, password_hash, password_salt FROM users WHERE id = ?`
  ).bind(data.user.id).first();
  if (!konto || !(await verifyPassword(alt, konto.password_hash, konto.password_salt))) {
    await loginFehlschlag(env, data.user.username, ip);
    return json({ error: 'Bisheriges Passwort stimmt nicht' }, { status: 403 });
  }

  const { hash, salt } = await createPasswordHash(String(neu));
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`)
      .bind(hash, salt, konto.id),
    sitzungenBeenden(env, konto.id, data.user.token),
    auditEintrag(env, data.user, { bereich: 'benutzer', aktion: 'passwort_eigen', objekt: 'user', objektId: konto.id }),
  ]);
  await loginErfolg(env, data.user.username);
  return json({ ok: true });
}
