// POST   /api/devices/:id — neuen Einrichtungs-Code ausstellen (Gerät neu aufsetzen)
// PATCH  /api/devices/:id — { revoked: true|false } Gerät sperren / entsperren
// DELETE /api/devices/:id — Geräte-Benutzer entfernen
//
// Alles nur für App-Admins. Sperren und Löschen beenden sofort alle Sessions
// des Geräts — wichtig, wenn ein Tablet verloren geht oder weitergegeben wird.
import {
  json, err, unauthorized, forbidden,
  isEpAdmin, deleteSessionsForUser,
} from '../../_lib/auth.js';
import { issueEnrollmentCode } from '../devices.js';
import { protokolliere, auditEintrag } from '../../_lib/audit.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

async function loadDevice(env, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { error: err('Ungültige ID') };
  const row = await env.DB.prepare(
    `SELECT id, username FROM users WHERE id = ? AND is_device = 1`
  ).bind(id).first();
  if (!row) return { error: err('Gerät nicht gefunden', 404) };
  return { device: row };
}

export async function onRequestPost({ env, params, data }) {
  const denied = requireAdmin(data); if (denied) return denied;
  const { device, error } = await loadDevice(env, params);
  if (error) return error;

  const enrollment = await issueEnrollmentCode(env, device.id, data.user.username);
  await protokolliere(env, data.user, { bereich: 'geraete', aktion: 'einrichtungscode', objekt: 'user', objektId: device.id, details: { username: device.username } });
  return json({ id: device.id, username: device.username, ...enrollment });
}

export async function onRequestPatch({ request, env, params, data }) {
  const denied = requireAdmin(data); if (denied) return denied;
  const { device, error } = await loadDevice(env, params);
  if (error) return error;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  if (typeof body?.revoked !== 'boolean') return err('revoked (true/false) erforderlich');

  if (body.revoked) {
    await env.DB.prepare(
      `UPDATE users SET device_revoked_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(device.id).run();
    await deleteSessionsForUser(env, device.id).catch(() => {});
  } else {
    // Entsperren reicht nur, solange noch ein Token hinterlegt ist. Ist das
    // Gerät neu aufzusetzen, braucht es zusätzlich einen Einrichtungs-Code.
    await env.DB.prepare(
      `UPDATE users SET device_revoked_at = NULL WHERE id = ?`
    ).bind(device.id).run();
  }

  await protokolliere(env, data.user, { bereich: 'geraete', aktion: body.revoked ? 'sperren' : 'entsperren', objekt: 'user', objektId: device.id, details: { username: device.username } });
  return json({ id: device.id, username: device.username, revoked: body.revoked });
}

export async function onRequestDelete({ env, params, data }) {
  const denied = requireAdmin(data); if (denied) return denied;
  const { device, error } = await loadDevice(env, params);
  if (error) return error;

  // sessions, user_roles und device_enrollments hängen per ON DELETE CASCADE dran.
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(device.id).run();
  await protokolliere(env, data.user, { bereich: 'geraete', aktion: 'loeschen', objekt: 'user', objektId: device.id, details: { username: device.username } });
  return json({ ok: true, id: device.id, username: device.username });
}
