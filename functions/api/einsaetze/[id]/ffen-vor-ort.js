// PUT /api/einsaetze/:id/ffen-vor-ort — Liste der FFen vor Ort komplett ersetzen.
// Wird typischerweise zu Einsatzbeginn einmal gesetzt; Konflikte selten.
import { json, err, unauthorized, forbidden, isEpWriter } from '../../../_lib/auth.js';
import { loadEditableEinsatz, touchEinsatz } from '../../einsaetze.js';

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, id);
  if (editable.error) return editable.error;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const ffIds = Array.isArray(body?.ff_ids)
    ? [...new Set(body.ff_ids.map((x) => Number(x)).filter(Number.isFinite))]
    : null;
  if (!ffIds) return err('ff_ids fehlt oder ungültig');

  await env.DB.prepare(`DELETE FROM einsatz_ffen_vor_ort WHERE einsatz_id = ?`).bind(id).run();
  if (ffIds.length) {
    const stmt = env.DB.prepare(`INSERT INTO einsatz_ffen_vor_ort (einsatz_id, ff_id) VALUES (?, ?)`);
    await env.DB.batch(ffIds.map((fid) => stmt.bind(id, fid)));
  }
  const updated_at = await touchEinsatz(env, id);
  return json({ ok: true, ff_ids: ffIds, updated_at });
}
