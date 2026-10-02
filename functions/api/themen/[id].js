// PUT    /api/themen/:id — Thema ändern (Admin)
// DELETE /api/themen/:id — Thema löschen (Admin)
//
// Löschen ist hier unkritisch: bereits erfasste Abende speichern das Thema
// als Freitext und bleiben dadurch unverändert lesbar. Soll ein Thema nur
// aus der Auswahlliste verschwinden, ist aktiv = 0 der sanftere Weg.
import { json, err, unauthorized, forbidden, isAppAdmin } from '../../_lib/auth.js';
import { validateThema } from '../themen.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

async function loadThema(env, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { error: err('Ungültige ID') };
  const row = await env.DB.prepare(
    `SELECT id, dienstart_id, thema FROM themen WHERE id = ?`
  ).bind(id).first();
  if (!row) return { error: err('Thema nicht gefunden', 404) };
  return { thema: row };
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { thema, error: notFound } = await loadThema(env, params);
  if (notFound) return notFound;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validateThema(body);
  if (error) return err(error);

  const da = await env.DB.prepare(`SELECT id FROM dienstarten WHERE id = ?`)
    .bind(value.dienstart_id).first();
  if (!da) return err('Dienstart nicht gefunden', 404);

  const kollision = await env.DB.prepare(
    `SELECT id FROM themen WHERE dienstart_id = ? AND thema = ? COLLATE NOCASE AND id != ?`
  ).bind(value.dienstart_id, value.thema, thema.id).first();
  if (kollision) return err('Dieses Thema gibt es in dieser Dienstart bereits', 409);

  await env.DB.prepare(
    `UPDATE themen SET dienstart_id = ?, thema = ?, abteilung = ?, prioritaet = ?, aktiv = ?
     WHERE id = ?`
  ).bind(value.dienstart_id, value.thema, value.abteilung, value.prioritaet, value.aktiv, thema.id).run();

  // Erfasste Abende tragen das Thema als Freitext — beim Umbenennen mitziehen.
  if (value.thema !== thema.thema) {
    await env.DB.prepare(
      `UPDATE attendance_sessions SET thema = ? WHERE thema = ? COLLATE NOCASE`
    ).bind(value.thema, thema.thema).run();
  }

  return json({ id: thema.id, ...value });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { thema, error } = await loadThema(env, params);
  if (error) return error;

  await env.DB.prepare(`DELETE FROM themen WHERE id = ?`).bind(thema.id).run();
  return json({ ok: true, id: thema.id });
}
