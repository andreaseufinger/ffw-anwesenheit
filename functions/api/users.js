// GET  /api/users — Liste aller Benutzer inkl. ihrer Rollen (App-Admin)
// POST /api/users — neuen Benutzer anlegen mit App-eigenen Rollen (App-Admin)
//
// Jede App-Instanz dieser Datei kann nur Rollen der eigenen App vergeben.
// Andere App-Rollen werden bei POST ignoriert; bei GET aber mit ausgegeben.
import {
  json, err, unauthorized, forbidden,
  APP_ROLES, ALL_ROLES, isAppAdmin,
  createPasswordHash, validateUsername, validatePassword,
} from '../_lib/auth.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

const APP_ROLE_SET = new Set([APP_ROLES.ADMIN, APP_ROLES.ERFASSER]);

export async function onRequestGet({ env, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.created_at,
            (SELECT GROUP_CONCAT(role, ',') FROM user_roles WHERE user_id = u.id) AS roles_csv
     FROM users u
     ORDER BY u.username COLLATE NOCASE`
  ).all();

  for (const r of results) {
    r.roles = r.roles_csv ? r.roles_csv.split(',').filter(Boolean) : [];
    delete r.roles_csv;
  }
  return json(results);
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireAdmin(data); if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  const requested = Array.isArray(body?.roles) ? body.roles : [];

  const e1 = validateUsername(username); if (e1) return err(e1);
  const e2 = validatePassword(password); if (e2) return err(e2);

  // Diese App-Instanz darf nur Rollen der eigenen App vergeben.
  const allowedRoles = requested.filter((r) => APP_ROLE_SET.has(r));
  const ignored = requested.filter((r) => ALL_ROLES.includes(r) && !APP_ROLE_SET.has(r));
  const unknown = requested.filter((r) => !ALL_ROLES.includes(r));
  if (unknown.length) return err(`unbekannte Rolle: ${unknown.join(', ')}`);
  if (!allowedRoles.length) return err('mindestens eine Rolle für diese App erforderlich');

  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE username = ? COLLATE NOCASE`
  ).bind(username).first();
  if (existing) return err('Benutzername bereits vergeben', 409);

  const { hash, salt } = await createPasswordHash(password);
  const res = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?)`
  ).bind(username, hash, salt).run();
  const userId = res.meta.last_row_id;

  const stmt = env.DB.prepare(`INSERT INTO user_roles (user_id, role) VALUES (?, ?)`);
  await env.DB.batch(allowedRoles.map((r) => stmt.bind(userId, r)));

  return json(
    { id: userId, username, roles: allowedRoles, ignored_roles: ignored },
    { status: 201 }
  );
}
