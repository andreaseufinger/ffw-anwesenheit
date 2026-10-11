// PUT    /api/tags/:id — Tag umbenennen / Sortierung ändern (Admin)
// DELETE /api/tags/:id — Tag löschen (Admin)
import { json, err, unauthorized, forbidden, isAppAdmin } from '../../_lib/auth.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data);
  if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  let body;
  try {
    body = await request.json();
  } catch {
    return err('Ungültiges JSON');
  }

  const updates = [];
  const binds = [];

  if (body?.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return err('Name fehlt');
    if (name.length > 80) return err('Name zu lang');
    const dup = await env.DB.prepare(
      `SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id != ?`
    )
      .bind(name, id)
      .first();
    if (dup) return err('Name bereits vergeben', 409);
    updates.push('name = ?');
    binds.push(name);
  }

  if (body?.sort_order !== undefined) {
    const sortOrder = Number(body.sort_order);
    if (!Number.isFinite(sortOrder)) return err('sort_order ungültig');
    updates.push('sort_order = ?');
    binds.push(Math.trunc(sortOrder));
  }

  if (!updates.length) return err('Keine Änderungen übergeben');
  binds.push(id);

  const res = await env.DB.prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  if (res.meta.changes === 0) return err('Nicht gefunden', 404);

  return json({ ok: true });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data);
  if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const res = await env.DB.prepare(`DELETE FROM tags WHERE id = ?`).bind(id).run();
  if (res.meta.changes === 0) return err('Nicht gefunden', 404);
  return json({ ok: true });
}
