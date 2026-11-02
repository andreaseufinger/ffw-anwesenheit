// POST /api/einsaetze/:id/pa — neuen PA-Träger anlegen.
// Body: { person_vorname?, person_nachname?, dauer_minuten? }
import { json, err, unauthorized, forbidden, isEpWriter } from '../../../_lib/auth.js';
import { loadEditableEinsatz, touchEinsatz, strOrNull, numOrNull } from '../../einsaetze.js';

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

  const pv = strOrNull(body?.person_vorname);
  const pn = strOrNull(body?.person_nachname);
  const dauer = numOrNull(body?.dauer_minuten);

  // sort_order: ans Ende anhängen
  const last = await env.DB.prepare(
    `SELECT COALESCE(MAX(sort_order), -1) AS m FROM einsatz_pa WHERE einsatz_id = ?`
  ).bind(id).first();
  const sortOrder = (last?.m ?? -1) + 1;

  const res = await env.DB.prepare(
    `INSERT INTO einsatz_pa (einsatz_id, person_nachname, person_vorname, dauer_minuten, sort_order, person_id)
     VALUES (?, ?, ?, ?, ?, (SELECT p.id FROM personen p WHERE p.nachname = ? COLLATE NOCASE AND p.vorname = ? COLLATE NOCASE))`
  ).bind(id, pn || '', pv || '', dauer, sortOrder, pn, pv).run();

  const updated_at = await touchEinsatz(env, id);
  return json({ id: res.meta.last_row_id, updated_at }, { status: 201 });
}
