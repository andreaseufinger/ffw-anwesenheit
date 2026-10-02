// PUT    /api/dienstarten/:id — Dienstart ändern (Admin)
// DELETE /api/dienstarten/:id — Dienstart löschen (Admin), nur ohne Themen
import { json, err, unauthorized, forbidden, isAppAdmin } from '../../_lib/auth.js';
import { validateDienstart } from '../dienstarten.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

async function loadDienstart(env, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { error: err('Ungültige ID') };
  const row = await env.DB.prepare(`SELECT id, name FROM dienstarten WHERE id = ?`).bind(id).first();
  if (!row) return { error: err('Dienstart nicht gefunden', 404) };
  return { dienstart: row };
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { dienstart, error: notFound } = await loadDienstart(env, params);
  if (notFound) return notFound;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validateDienstart(body);
  if (error) return err(error);

  const kollision = await env.DB.prepare(
    `SELECT id FROM dienstarten WHERE name = ? COLLATE NOCASE AND id != ?`
  ).bind(value.name, dienstart.id).first();
  if (kollision) return err('Eine andere Dienstart trägt diesen Namen bereits', 409);

  await env.DB.prepare(
    `UPDATE dienstarten SET name = ?, kategorie = ?, sort_order = ? WHERE id = ?`
  ).bind(value.name, value.kategorie, value.sort_order, dienstart.id).run();

  // Bereits erfasste Abende tragen die Dienstart als Freitext. Beim Umbenennen
  // werden sie mitgezogen, sonst fallen sie in der Auswertung aus der Gruppe.
  if (value.name !== dienstart.name) {
    await env.DB.prepare(
      `UPDATE attendance_sessions SET dienstart = ? WHERE dienstart = ? COLLATE NOCASE`
    ).bind(value.name, dienstart.name).run();
  }

  return json({ id: dienstart.id, ...value });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { dienstart, error } = await loadDienstart(env, params);
  if (error) return error;

  const genutzt = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM themen WHERE dienstart_id = ?`
  ).bind(dienstart.id).first();
  if ((genutzt?.c ?? 0) > 0) {
    return err(`Dienstart hat noch ${genutzt.c} Thema/Themen — diese zuerst umhängen oder löschen`, 409);
  }

  await env.DB.prepare(`DELETE FROM dienstarten WHERE id = ?`).bind(dienstart.id).run();
  return json({ ok: true, id: dienstart.id });
}
