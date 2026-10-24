// PUT    /api/personen-rollen/:id — Rolle umbenennen (nur übergreifender Admin)
// DELETE /api/personen-rollen/:id — Rolle löschen (nur übergreifender Admin)
//
// Löschen ist unkritisch: rolle_id steht auf ON DELETE SET NULL, die
// Zugehörigkeiten bleiben also erhalten und verlieren nur die Rolle. Weil das
// in der Auswertung aber als Gruppe "ohne Rolle" sichtbar würde, nennt die
// Antwort die Zahl der betroffenen Zuordnungen.
import { json, err, unauthorized, forbidden, isUebergreifenderAdmin } from '../../_lib/auth.js';
import { validatePersonenRolle } from '../personen-rollen.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isUebergreifenderAdmin(data.user)) return forbidden();
  return null;
}

async function loadRolle(env, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { error: err('Ungültige ID') };
  const row = await env.DB.prepare(
    `SELECT id, name FROM personen_rollen WHERE id = ?`
  ).bind(id).first();
  if (!row) return { error: err('Rolle nicht gefunden', 404) };
  return { rolle: row };
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { rolle, error: notFound } = await loadRolle(env, params);
  if (notFound) return notFound;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validatePersonenRolle(body);
  if (error) return err(error);

  const kollision = await env.DB.prepare(
    `SELECT id FROM personen_rollen WHERE name = ? COLLATE NOCASE AND id != ?`
  ).bind(value.name, rolle.id).first();
  if (kollision) return err('Eine andere Rolle trägt diesen Namen bereits', 409);

  await env.DB.prepare(
    `UPDATE personen_rollen SET name = ?, sort_order = ? WHERE id = ?`
  ).bind(value.name, value.sort_order, rolle.id).run();

  return json({ id: rolle.id, ...value });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { rolle, error } = await loadRolle(env, params);
  if (error) return error;

  const n = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM personen_abteilungen WHERE rolle_id = ?`
  ).bind(rolle.id).first();

  await env.DB.prepare(`DELETE FROM personen_rollen WHERE id = ?`).bind(rolle.id).run();
  return json({ ok: true, id: rolle.id, name: rolle.name, betroffen: n?.c ?? 0 });
}
