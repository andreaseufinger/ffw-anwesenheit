// PUT    /api/einsaetze/:id/pa/:paId — Person/Dauer eines PA-Eintrags aktualisieren
// DELETE /api/einsaetze/:id/pa/:paId — PA-Eintrag entfernen
import { json, err, unauthorized, forbidden, isEpWriter } from '../../../../_lib/auth.js';
import { loadEditableEinsatz, touchEinsatz, strOrNull, numOrNull } from '../../../einsaetze.js';

async function loadPaInEinsatz(env, einsatzId, paId) {
  return await env.DB.prepare(
    `SELECT id FROM einsatz_pa WHERE id = ? AND einsatz_id = ?`
  ).bind(paId, einsatzId).first();
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const einsatzId = Number(params.id);
  const paId = Number(params.paId);
  if (!Number.isFinite(einsatzId) || !Number.isFinite(paId)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, einsatzId);
  if (editable.error) return editable.error;

  const row = await loadPaInEinsatz(env, einsatzId, paId);
  if (!row) return err('PA-Eintrag nicht gefunden', 404);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const updates = []; const binds = [];
  if ('person_vorname'  in body) { updates.push('person_vorname = ?');  binds.push(strOrNull(body.person_vorname) || ''); }
  if ('person_nachname' in body) { updates.push('person_nachname = ?'); binds.push(strOrNull(body.person_nachname) || ''); }
  if ('dauer_minuten'   in body) { updates.push('dauer_minuten = ?');   binds.push(numOrNull(body.dauer_minuten)); }
  if (!updates.length) return err('Keine Änderungen');

  binds.push(paId);
  await env.DB.prepare(`UPDATE einsatz_pa SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
  const updated_at = await touchEinsatz(env, einsatzId);
  return json({ ok: true, updated_at });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const einsatzId = Number(params.id);
  const paId = Number(params.paId);
  if (!Number.isFinite(einsatzId) || !Number.isFinite(paId)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, einsatzId);
  if (editable.error) return editable.error;

  const row = await loadPaInEinsatz(env, einsatzId, paId);
  if (!row) return err('PA-Eintrag nicht gefunden', 404);

  await env.DB.prepare(`DELETE FROM einsatz_pa WHERE id = ?`).bind(paId).run();
  const updated_at = await touchEinsatz(env, einsatzId);
  return json({ ok: true, updated_at });
}
