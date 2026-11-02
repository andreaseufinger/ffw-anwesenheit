// GET /api/einsaetze/:id/state — leichtgewichtige Polling-Antwort.
// Liefert nur Status + updated_at, damit Clients erkennen, ob sich etwas
// geändert hat und ein voller Reload nötig ist.
import { json, err, unauthorized } from '../../../_lib/auth.js';

export async function onRequestGet({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const row = await env.DB.prepare(
    `SELECT id, status, abgeschlossen_at, abgeschlossen_by, updated_at
     FROM einsaetze WHERE id = ?`
  ).bind(id).first();
  if (!row) return err('Nicht gefunden', 404);

  return json(row);
}
