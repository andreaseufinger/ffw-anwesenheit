// PUT    /api/fahrzeuge/:id — bearbeiten (Admin)
// DELETE /api/fahrzeuge/:id — löschen (Admin, nur wenn nicht in einem Einsatz verwendet)
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

  const existing = await env.DB.prepare(`SELECT id FROM einsatz_fahrzeuge_stamm WHERE id = ?`).bind(id).first();
  if (!existing) return err('Nicht gefunden', 404);

  const updates = [];
  const binds = [];

  if (body?.kennung !== undefined) {
    const k = String(body.kennung).trim();
    if (!k) return err('Kennung fehlt');
    updates.push('kennung = ?'); binds.push(k);
  }
  if (body?.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) return err('Name fehlt');
    updates.push('name = ?'); binds.push(n);
  }
  if (body?.positionen !== undefined) {
    if (!Array.isArray(body.positionen)) return err('Positionen müssen Array sein');
    const cleaned = body.positionen.map((p) => String(p || '').trim()).filter(Boolean);
    if (!cleaned.length) return err('Positionen leer');
    if (new Set(cleaned).size !== cleaned.length) return err('Positionen müssen eindeutig sein');
    updates.push('positionen = ?'); binds.push(JSON.stringify(cleaned));
  }
  if (body?.sort_order !== undefined) {
    updates.push('sort_order = ?'); binds.push(Math.trunc(Number(body.sort_order) || 0));
  }
  if (body?.aktiv !== undefined) {
    updates.push('aktiv = ?'); binds.push(body.aktiv ? 1 : 0);
  }

  if (!updates.length) return err('Keine Änderungen');
  binds.push(id);

  await env.DB.prepare(`UPDATE einsatz_fahrzeuge_stamm SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
  return json({ ok: true });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const inUse = await env.DB.prepare(`SELECT COUNT(*) AS c FROM einsatz_fahrzeuge WHERE fahrzeug_id = ?`).bind(id).first();
  if ((inUse?.c ?? 0) > 0) return err('Fahrzeug ist in Einsätzen verwendet — stattdessen auf inaktiv setzen', 409);

  await env.DB.prepare(`DELETE FROM einsatz_fahrzeuge_stamm WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}
