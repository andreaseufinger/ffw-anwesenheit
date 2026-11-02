// POST /api/einsaetze/:id/verunfallte — neues Kennzeichen anlegen.
import { json, err, unauthorized, forbidden, isEpWriter } from '../../../_lib/auth.js';
import { loadEditableEinsatz, touchEinsatz, strOrNull } from '../../einsaetze.js';

export async function onRequestPost({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, id);
  if (editable.error) return editable.error;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const kz = strOrNull(body?.kennzeichen) || '';

  const last = await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM einsatz_verunfallte WHERE einsatz_id = ?`
  ).bind(id).first();
  const sortOrder = (last?.m ?? -1) + 1;

  const res = await env.DB.prepare(
    `INSERT INTO einsatz_verunfallte (einsatz_id, kennzeichen, sort_order) VALUES (?, ?, ?)`
  ).bind(id, kz, sortOrder).run();

  const updated_at = await touchEinsatz(env, id);
  return json({ id: res.meta.last_row_id, updated_at }, { status: 201 });
}
