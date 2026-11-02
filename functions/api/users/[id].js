// PUT    /api/users/:id  { password?, roles? } — App-Admin
// DELETE /api/users/:id — App-Admin (siehe Logik unten: kaskadiert nur eigene Rollen)
//
// Diese App-Instanz darf nur App-eigene Rollen (APP_ROLES) ändern. Fremde
// App-Rollen bleiben bei PUT unangetastet.
// DELETE entfernt die App-eigenen Rollen. Hat der Benutzer danach keine
// Rollen mehr in irgendeiner App, wird er komplett gelöscht.
import {
  json, err, unauthorized, forbidden,
  APP_ROLES, ALL_ROLES, isAppAdmin,
  createPasswordHash, validatePassword, sitzungenBeenden,
} from '../../_lib/auth.js';
import { protokolliere, auditEintrag } from '../../_lib/audit.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

const APP_ROLE_SET = new Set(Object.values(APP_ROLES));

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

  const target = await env.DB.prepare(`SELECT id, username FROM users WHERE id = ?`).bind(id).first();
  if (!target) return err('Nicht gefunden', 404);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const hasPassword = body?.password !== undefined;
  const hasRoles    = Array.isArray(body?.roles);
  const hasAbt      = Array.isArray(body?.abteilung_ids);
  if (!hasPassword && !hasRoles && !hasAbt) return err('Keine Änderungen übergeben');

  // Erst alles prüfen, dann alles in einem Batch schreiben. Vorher wurden
  // Abteilungen und Passwort schon geschrieben, bevor eine ungültige Rolle
  // abgelehnt wurde (Review-Befund S1).
  if (hasPassword) {
    const e = validatePassword(body.password); if (e) return err(e);
  }

  let finalRoles = null, otherAppRoles = [];
  if (hasRoles) {
    const requested = body.roles.filter((r) => typeof r === 'string');
    const unknown = requested.filter((r) => !ALL_ROLES.includes(r));
    if (unknown.length) return err(`unbekannte Rolle: ${unknown.join(', ')}`);

    const newAppRoles = new Set(requested.filter((r) => APP_ROLE_SET.has(r)));
    const currentRoles = await loadUserRoles(env, id);
    otherAppRoles = currentRoles.filter((r) => !APP_ROLE_SET.has(r));

    // Schutz: letzter Admin dieser App nicht degradieren
    if (!newAppRoles.has(APP_ROLES.ADMIN) && currentRoles.includes(APP_ROLES.ADMIN)) {
      const otherAdmins = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM user_roles WHERE role = ? AND user_id != ?`
      ).bind(APP_ROLES.ADMIN, id).first();
      if ((otherAdmins?.c ?? 0) === 0) {
        return err('Letzter Admin dieser App kann nicht entfernt werden', 400);
      }
    }
    finalRoles = [...newAppRoles];
  }

  const schritte = [];
  if (hasAbt) {
    const abtIds = [...new Set(body.abteilung_ids.map(Number).filter(Number.isFinite))];
    schritte.push(env.DB.prepare(`DELETE FROM user_abteilungen WHERE user_id = ?`).bind(id));
    const aStmt = env.DB.prepare(
      `INSERT OR IGNORE INTO user_abteilungen (user_id, abteilung_id) VALUES (?, ?)`
    );
    schritte.push(...abtIds.map((a) => aStmt.bind(id, a)));
  }
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
    // App-eigene Rollen ersetzen, andere belassen. Alle App-Rollen, nicht
    // nur Admin/Erfasser: sonst blieb ein abgewählter Abteilungsadmin stehen.
    const appRollen = [...APP_ROLE_SET];
    schritte.push(env.DB.prepare(
      `DELETE FROM user_roles WHERE user_id = ? AND role IN (${appRollen.map(() => '?').join(', ')})`
    ).bind(id, ...appRollen));
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)`);
    schritte.push(...finalRoles.map((r) => stmt.bind(id, r)));
    if (loeschen) schritte.push(env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id));
  }
  schritte.push(auditEintrag(env, data.user, { bereich: 'benutzer', aktion: loeschen ? 'loeschen' : 'aendern',
    objekt: 'user', objektId: id, details: { username: target.username, rollen: finalRoles ?? undefined,
      abteilung_ids: hasAbt ? body.abteilung_ids : undefined, passwort_gesetzt: hasPassword || undefined } }));
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
  const wasAdmin = currentRoles.includes(APP_ROLES.ADMIN);
  if (wasAdmin) {
    const otherAdmins = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM user_roles WHERE role = ? AND user_id != ?`
    ).bind(APP_ROLES.ADMIN, id).first();
    if ((otherAdmins?.c ?? 0) === 0) {
      return err('Letzter Admin dieser App kann nicht gelöscht werden', 400);
    }
  }

  // App-eigene Rollen entfernen
  const appRollen = [...APP_ROLE_SET];
  await env.DB.prepare(
    `DELETE FROM user_roles WHERE user_id = ? AND role IN (${appRollen.map(() => '?').join(', ')})`
  ).bind(id, ...appRollen).run();

  await protokolliere(env, data.user, { bereich: 'benutzer', aktion: 'rollen_entfernen', objekt: 'user', objektId: id,
    details: { app: 'anwesenheit', geloescht: !currentRoles.some((r) => !APP_ROLE_SET.has(r)) } });
  // Falls der Benutzer keine Rollen in einer anderen App mehr hat → komplett löschen
  const otherRolesLeft = currentRoles.some((r) => !APP_ROLE_SET.has(r));
  if (!otherRolesLeft) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
    return json({ ok: true, deleted: true });
  }
  return json({ ok: true, deleted: false });
}
