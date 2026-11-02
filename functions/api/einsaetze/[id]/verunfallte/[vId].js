// PUT    /api/einsaetze/:id/verunfallte/:vId — Kennzeichen aktualisieren
// DELETE /api/einsaetze/:id/verunfallte/:vId — Kennzeichen entfernen
import { json, err, unauthorized, forbidden, isEpWriter } from '../../../../_lib/auth.js';
import { loadEditableEinsatz, touchEinsatz, strOrNull } from '../../../einsaetze.js';

async function loadVerInEinsatz(env, einsatzId, vId) {
  return await env.DB.prepare(
    `SELECT id FROM einsatz_verunfallte WHERE id = ? AND einsatz_id = ?`
  ).bind(vId, einsatzId).first();
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const einsatzId = Number(params.id);
  const vId = Number(params.vId);
  if (!Number.isFinite(einsatzId) || !Number.isFinite(vId)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, einsatzId);
  if (editable.error) return editable.error;

  const row = await loadVerInEinsatz(env, einsatzId, vId);
  if (!row) return err('Kennzeichen nicht gefunden', 404);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  if (!('kennzeichen' in body)) return err('kennzeichen fehlt');

  await env.DB.prepare(`UPDATE einsatz_verunfallte SET kennzeichen = ? WHERE id = ?`)
    .bind(strOrNull(body.kennzeichen) || '', vId).run();
  const updated_at = await touchEinsatz(env, einsatzId);
  return json({ ok: true, updated_at });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const einsatzId = Number(params.id);
  const vId = Number(params.vId);
  if (!Number.isFinite(einsatzId) || !Number.isFinite(vId)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, einsatzId);
  if (editable.error) return editable.error;

  const row = await loadVerInEinsatz(env, einsatzId, vId);
  if (!row) return err('Kennzeichen nicht gefunden', 404);

  await env.DB.prepare(`DELETE FROM einsatz_verunfallte WHERE id = ?`).bind(vId).run();
  const updated_at = await touchEinsatz(env, einsatzId);
  return json({ ok: true, updated_at });
}
