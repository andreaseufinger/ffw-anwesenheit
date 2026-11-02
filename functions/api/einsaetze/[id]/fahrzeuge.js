// POST /api/einsaetze/:id/fahrzeuge — Fahrzeug zum Einsatz hinzufügen.
// Body: { fahrzeug_id }
// Antwort: { id: <einsatz_fahrzeug.id> }
import { json, err, unauthorized, forbidden, isEpWriter } from '../../../_lib/auth.js';
import { loadEditableEinsatz, touchEinsatz } from '../../einsaetze.js';

export async function onRequestPost({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const einsatzId = Number(params.id);
  if (!Number.isFinite(einsatzId)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, einsatzId);
  if (editable.error) return editable.error;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const fahrzeugId = Number(body?.fahrzeug_id);
  if (!Number.isFinite(fahrzeugId)) return err('fahrzeug_id fehlt');

  const exists = await env.DB.prepare(
    `SELECT id FROM einsatz_fahrzeuge WHERE einsatz_id = ? AND fahrzeug_id = ?`
  ).bind(einsatzId, fahrzeugId).first();
  if (exists) return json({ id: exists.id }, { status: 200 });

  const res = await env.DB.prepare(
    `INSERT INTO einsatz_fahrzeuge (einsatz_id, fahrzeug_id) VALUES (?, ?)`
  ).bind(einsatzId, fahrzeugId).run();

  const updated_at = await touchEinsatz(env, einsatzId);
  return json({ id: res.meta.last_row_id, updated_at }, { status: 201 });
}
