// PUT    /api/users/:id  { password?, roles? } — App-Admin
// DELETE /api/users/:id — App-Admin (siehe Logik unten: kaskadiert nur eigene Rollen)
//
// Diese App-Instanz darf nur App-eigene Rollen (EP_ROLES) ändern. Fremde
// App-Rollen bleiben bei PUT unangetastet.
// DELETE entfernt die App-eigenen Rollen. Hat der Benutzer danach keine
// Rollen mehr in irgendeiner App, wird er komplett gelöscht.
import {
  json, err, unauthorized, forbidden,
  EP_ROLES, ALL_ROLES, isEpAdmin,
  createPasswordHash, validatePassword, sitzungenBeenden,
} from '../../../_lib/auth.js';
import { protokolliere, auditEintrag } from '../../../_lib/audit.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

const APP_ROLE_SET = new Set([EP_ROLES.ADMIN, EP_ROLES.ERFASSER, EP_ROLES.LESER]);
const APP_ROLE_LIST = [...APP_ROLE_SET];
const APP_ROLE_PLACEHOLDERS = APP_ROLE_LIST.map(() => '?').join(', ');

async function loadUserRoles(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE user_id = ?`
  ).bind(userId).all();
  return results.map((r) => r.role);
}

export async function onRequestPut({ request, env, params, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const target = await env.DB.prepare(
    `SELECT id, username, is_device FROM users WHERE id = ?`
  ).bind(id).first();
  if (!target) return err('Nicht gefunden', 404);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const hasPassword = body?.password !== undefined;
  const hasRoles    = Array.isArray(body?.roles);
  if (!hasPassword && !hasRoles) return err('Keine Änderungen übergeben');

  // Geräte-Benutzer (LF10, GW) haben kein Passwort — sie werden über
  // /api/devices neu eingerichtet oder gesperrt.
  if (target.is_device && hasPassword) {
    return err('Geräte haben kein Passwort — bitte über die Geräte-Verwaltung neu einrichten', 400);
  }
  // Ein Gerät darf nie mehr als erfassen dürfen: es meldet sich ohne
  // Zutun eines Menschen an, wer am Fahrzeug ist, hat damit Zugriff.
  if (target.is_device && hasRoles && body.roles.some((r) => r !== EP_ROLES.ERFASSER)) {
    return err('Geräte dürfen ausschließlich die Erfasser-Rolle haben', 400);
  }

  // Erst alles prüfen, dann alles in einem Batch schreiben. Vorher wurde das
  // Passwort schon geschrieben, bevor eine ungültige Rolle abgelehnt wurde
  // (Review-Befund S1).
  if (hasPassword) {
    const e = validatePassword(body.password); if (e) return err(e);
  }

  let finalRoles = null, otherAppRoles = [];
  if (hasRoles) {
    // Diese App darf nur App-eigene Rollen setzen.
    const requested = body.roles.filter((r) => typeof r === 'string');
    const unknown = requested.filter((r) => !ALL_ROLES.includes(r));
    if (unknown.length) return err(`unbekannte Rolle: ${unknown.join(', ')}`);

    const newAppRoles = new Set(requested.filter((r) => APP_ROLE_SET.has(r)));
    const currentRoles = await loadUserRoles(env, id);
    otherAppRoles = currentRoles.filter((r) => !APP_ROLE_SET.has(r));

    // Schutz: letzter Admin dieser App nicht degradieren
    if (!newAppRoles.has(EP_ROLES.ADMIN) && currentRoles.includes(EP_ROLES.ADMIN)) {
      const otherAdmins = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM user_roles WHERE role = ? AND user_id != ?`
      ).bind(EP_ROLES.ADMIN, id).first();
      if ((otherAdmins?.c ?? 0) === 0) {
        return err('Letzter Admin dieser App kann nicht entfernt werden', 400);
      }
    }
    finalRoles = [...newAppRoles];
  }

  const schritte = [];
  if (hasPassword) {
    const { hash, salt } = await createPasswordHash(String(body.password));
    schritte.push(env.DB.prepare(
      `UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`
    ).bind(hash, salt, id));
    // Neues Passwort beendet alle laufenden Sitzungen dieses Kontos (SEC3):
    // wer das alte kannte, soll nicht angemeldet bleiben.
    schritte.push(sitzungenBeenden(env, id));
  }
  // Hat der User danach in keiner App mehr eine Rolle? Dann komplett
  // löschen, damit keine "verwaisten" Logins entstehen.
  const loeschen = finalRoles !== null && !finalRoles.length && !otherAppRoles.length;
  if (finalRoles !== null) {
    // App-eigene Rollen ersetzen, andere belassen
    schritte.push(env.DB.prepare(
      `DELETE FROM user_roles WHERE user_id = ? AND role IN (${APP_ROLE_PLACEHOLDERS})`
    ).bind(id, ...APP_ROLE_LIST));
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)`);
    schritte.push(...finalRoles.map((r) => stmt.bind(id, r)));
    if (loeschen) schritte.push(env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id));
  }
  schritte.push(auditEintrag(env, data.user, { bereich: 'benutzer', aktion: loeschen ? 'loeschen' : 'aendern',
    objekt: 'user', objektId: id, details: { username: target.username, rollen: finalRoles ?? undefined,
      passwort_gesetzt: hasPassword || undefined, app: 'einsatzprotokoll' } }));
  await env.DB.batch(schritte);

  return json(loeschen ? { ok: true, deleted: true } : { ok: true });
}

export async function onRequestDelete({ env, params, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  if (id === data.user.id) return err('Eigenen Account nicht löschbar', 400);

  const target = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(id).first();
  if (!target) return err('Nicht gefunden', 404);

  const currentRoles = await loadUserRoles(env, id);
  const wasAdmin = currentRoles.includes(EP_ROLES.ADMIN);
  if (wasAdmin) {
    const otherAdmins = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM user_roles WHERE role = ? AND user_id != ?`
    ).bind(EP_ROLES.ADMIN, id).first();
    if ((otherAdmins?.c ?? 0) === 0) {
      return err('Letzter Admin dieser App kann nicht gelöscht werden', 400);
    }
  }

  // App-eigene Rollen entfernen
  await env.DB.prepare(
    `DELETE FROM user_roles WHERE user_id = ? AND role IN (${APP_ROLE_PLACEHOLDERS})`
  ).bind(id, ...APP_ROLE_LIST).run();

  await protokolliere(env, data.user, { bereich: 'benutzer', aktion: 'rollen_entfernen', objekt: 'user', objektId: id,
    details: { app: 'einsatzprotokoll', geloescht: !currentRoles.some((r) => !APP_ROLE_SET.has(r)) } });
  // Falls der Benutzer keine Rollen in einer anderen App mehr hat → komplett löschen
  const otherRolesLeft = currentRoles.some((r) => !APP_ROLE_SET.has(r));
  if (!otherRolesLeft) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
    return json({ ok: true, deleted: true });
  }
  return json({ ok: true, deleted: false });
}
