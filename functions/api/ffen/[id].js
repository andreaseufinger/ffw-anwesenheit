// PUT    /api/ffen/:id — bearbeiten (Admin)
// DELETE /api/ffen/:id — löschen (Admin)
import { json, err, unauthorized, forbidden, isEpAdmin } from '../../_lib/auth.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();
  return null;
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const existing = await env.DB.prepare(`SELECT id FROM einsatz_ffen_stamm WHERE id = ?`).bind(id).first();
  if (!existing) return err('Nicht gefunden', 404);

  const updates = []; const binds = [];
  if (body?.kuerzel !== undefined) {
    const k = String(body.kuerzel).trim();
    if (!k) return err('Kürzel fehlt');
    updates.push('kuerzel = ?'); binds.push(k);
  }
  if (body?.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) return err('Name fehlt');
    updates.push('name = ?'); binds.push(n);
  }
  if (body?.sort_order !== undefined) {
    updates.push('sort_order = ?'); binds.push(Math.trunc(Number(body.sort_order) || 0));
  }
  if (body?.aktiv !== undefined) {
    updates.push('aktiv = ?'); binds.push(body.aktiv ? 1 : 0);
  }

  if (!updates.length) return err('Keine Änderungen');
  binds.push(id);
  await env.DB.prepare(`UPDATE einsatz_ffen_stamm SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
  return json({ ok: true });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  await env.DB.prepare(`DELETE FROM einsatz_ffen_stamm WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}
