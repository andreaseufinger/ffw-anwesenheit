// GET  /api/devices — Geräte-Benutzer (LF10, GW) inkl. Status (App-Admin)
// POST /api/devices — neuen Geräte-Benutzer anlegen, liefert Einrichtungs-Code
//
// Ein Geräte-Benutzer entspricht genau EINEM physischen Gerät. Es gibt deshalb
// keine eigene Geräte-Tabelle: die Identität des Geräts ist der Benutzername.
import {
  json, err, unauthorized, forbidden,
  EP_ROLES, isEpAdmin, validateDeviceName,
  createPasswordHash, sha256Hex,
  newEnrollmentCode, enrollmentExpiresAt, ENROLLMENT_TTL_MINUTES,
} from '../_lib/auth.js';
import { protokolliere, auditEintrag } from '../_lib/audit.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

// Einen frischen Einmal-Code für ein Gerät ausstellen. Frühere, noch offene
// Codes desselben Geräts werden verworfen — es soll immer höchstens einer gelten.
export async function issueEnrollmentCode(env, userId, adminUsername) {
  const code = newEnrollmentCode();
  const codeHash = await sha256Hex(code);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM device_enrollments WHERE user_id = ? AND used_at IS NULL`).bind(userId),
    env.DB.prepare(
      `INSERT INTO device_enrollments (code_hash, user_id, expires_at, created_by)
       VALUES (?, ?, ?, ?)`
    ).bind(codeHash, userId, enrollmentExpiresAt(), adminUsername),
  ]);
  return {
    enroll_code: code,
    enroll_url: `/einsatzprotokoll/enroll?code=${code}`,
    expires_in_minutes: ENROLLMENT_TTL_MINUTES,
  };
}

export async function onRequestGet({ env, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.created_at, u.device_token_prefix,
            u.device_revoked_at, u.last_seen_at, u.last_seen_ip,
            (SELECT GROUP_CONCAT(role, ',') FROM user_roles WHERE user_id = u.id) AS roles_csv
     FROM users u
     WHERE u.is_device = 1
     ORDER BY u.username COLLATE NOCASE`
  ).all();

  for (const r of results) {
    r.roles = r.roles_csv ? r.roles_csv.split(',').filter(Boolean) : [];
    delete r.roles_csv;
    // eingerichtet = Token vorhanden; gesperrt schlägt das
    r.status = r.device_revoked_at ? 'gesperrt'
      : (r.device_token_prefix ? 'eingerichtet' : 'nicht eingerichtet');
  }
  return json(results);
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const username = String(body?.username || '').trim();

  const e1 = validateDeviceName(username); if (e1) return err(e1);

  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE username = ? COLLATE NOCASE`
  ).bind(username).first();
  if (existing) return err('Benutzername bereits vergeben', 409);

  // users.password_hash/-salt sind NOT NULL. Geräte bekommen einen zufälligen,
  // nie kommunizierten Wert — der Passwort-Login lehnt is_device = 1 ohnehin
  // ab, bevor er überhaupt verglichen wird (siehe auth/login.js).
  const { hash, salt } = await createPasswordHash(newEnrollmentCode());

  const res = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, password_salt, is_device)
     VALUES (?, ?, ?, 1)`
  ).bind(username, hash, salt).run();
  const userId = res.meta.last_row_id;

  // Geräte dürfen ausschließlich erfassen — kein Admin, kein Abschließen,
  // kein Löschen, kein Zugriff auf die Anwesenheit-App.
  await env.DB.prepare(
    `INSERT INTO user_roles (user_id, role) VALUES (?, ?)`
  ).bind(userId, EP_ROLES.ERFASSER).run();

  const enrollment = await issueEnrollmentCode(env, userId, data.user.username);

  await protokolliere(env, data.user, { bereich: 'geraete', aktion: 'anlegen', objekt: 'user', objektId: userId, details: { username } });

  return json(
    { id: userId, username, roles: [EP_ROLES.ERFASSER], ...enrollment },
    { status: 201 }
  );
}
