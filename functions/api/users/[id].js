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
  createPasswordHash, validatePassword,
} from '../../_lib/auth.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

const APP_ROLE_SET = new Set([APP_ROLES.ADMIN, APP_ROLES.ERFASSER]);

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
  if (!hasPassword && !hasRoles) return err('Keine Änderungen übergeben');

  // Passwort
  if (hasPassword) {
    const e = validatePassword(body.password); if (e) return err(e);
    const { hash, salt } = await createPasswordHash(String(body.password));
    await env.DB.prepare(
      `UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?`
    ).bind(hash, salt, id).run();
  }

  // Rollen — diese App darf nur App-eigene Rollen setzen.
  if (hasRoles) {
    const requested = body.roles.filter((r) => typeof r === 'string');
    const unknown = requested.filter((r) => !ALL_ROLES.includes(r));
    if (unknown.length) return err(`unbekannte Rolle: ${unknown.join(', ')}`);

    const newAppRoles = new Set(requested.filter((r) => APP_ROLE_SET.has(r)));
    const currentRoles = await loadUserRoles(env, id);
    const otherAppRoles = currentRoles.filter((r) => !APP_ROLE_SET.has(r));

    // Schutz: letzter Admin dieser App nicht degradieren
    if (!newAppRoles.has(APP_ROLES.ADMIN)) {
      const wasAdmin = currentRoles.includes(APP_ROLES.ADMIN);
      if (wasAdmin) {
        const otherAdmins = await env.DB.prepare(
          `SELECT COUNT(*) AS c FROM user_roles WHERE role = ? AND user_id != ?`
        ).bind(APP_ROLES.ADMIN, id).first();
        if ((otherAdmins?.c ?? 0) === 0) {
          return err('Letzter Admin dieser App kann nicht entfernt werden', 400);
        }
      }
    }

    // App-eigene Rollen ersetzen, andere belassen
    await env.DB.prepare(
      `DELETE FROM user_roles WHERE user_id = ? AND role IN (?, ?)`
    ).bind(id, APP_ROLES.ADMIN, APP_ROLES.ERFASSER).run();

    const finalRoles = [...newAppRoles];
    if (finalRoles.length) {
      const stmt = env.DB.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)`);
      await env.DB.batch(finalRoles.map((r) => stmt.bind(id, r)));
    }

    // Hat der User in keiner App mehr eine Rolle? Dann besser komplett löschen,
    // damit keine "verwaisten" Logins entstehen.
    const remaining = [...finalRoles, ...otherAppRoles];
    if (!remaining.length) {
      await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
      return json({ ok: true, deleted: true });
    }
  }

  return json({ ok: true });
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
  await env.DB.prepare(
    `DELETE FROM user_roles WHERE user_id = ? AND role IN (?, ?)`
  ).bind(id, APP_ROLES.ADMIN, APP_ROLES.ERFASSER).run();

  // Falls der Benutzer keine Rollen in einer anderen App mehr hat → komplett löschen
  const otherRolesLeft = currentRoles.some((r) => !APP_ROLE_SET.has(r));
  if (!otherRolesLeft) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
    return json({ ok: true, deleted: true });
  }
  return json({ ok: true, deleted: false });
}
