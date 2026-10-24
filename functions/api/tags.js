// GET  /api/tags — Liste aller Tags (eingeloggte Benutzer)
// POST /api/tags — neuen Tag anlegen (Admin)
import { json, err, unauthorized, forbidden, isAppAdmin } from '../_lib/auth.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const { results } = await env.DB.prepare(
    `SELECT id, name, sort_order FROM tags
     ORDER BY sort_order ASC, name COLLATE NOCASE ASC`
  ).all();
  return json(results);
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return err('Ungültiges JSON');
  }

  const name = String(body?.name || '').trim();
  if (!name) return err('Name fehlt');
  if (name.length > 80) return err('Name zu lang');

  const sortOrder = Number.isFinite(body?.sort_order) ? Math.trunc(body.sort_order) : 100;

  const existing = await env.DB.prepare(
    `SELECT id FROM tags WHERE name = ? COLLATE NOCASE`
  )
    .bind(name)
    .first();
  if (existing) return err('Name bereits vergeben', 409);

  const res = await env.DB.prepare(
    `INSERT INTO tags (name, sort_order) VALUES (?, ?)`
  )
    .bind(name, sortOrder)
    .run();

  return json({ id: res.meta.last_row_id, name, sort_order: sortOrder }, { status: 201 });
}
