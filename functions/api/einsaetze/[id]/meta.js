// PUT /api/einsaetze/:id/meta — partielles Update der Kopfdaten
// Body darf nur die zu ändernden Felder enthalten (last-write-wins pro Feld).
import { json, err, unauthorized, forbidden, isEpWriter } from '../../../_lib/auth.js';
import { loadEditableEinsatz, strOrNull, numOrNull } from '../../einsaetze.js';

const SCALAR_FIELDS = {
  alarm_datum:      (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null,
  alarm_uhrzeit:    (v) => /^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : null,
  einsatzort:       strOrNull,
  einsatzgrund:     strOrNull,
  einsatzleiter:    strOrNull,
  km_einsatzstelle: numOrNull,
  km_gesamt:        numOrNull,
  erste_ff_id:      (v) => v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null),
  notizen:          strOrNull,
  alarmierte_einheit: strOrNull,
};

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
  if (!body || typeof body !== 'object') return err('Body ungültig');

  const updates = []; const binds = [];
  for (const [key, normalize] of Object.entries(SCALAR_FIELDS)) {
    if (!(key in body)) continue;
    if (key === 'alarm_datum' || key === 'alarm_uhrzeit') {
      const v = normalize(body[key]);
      if (v == null) return err(`${key} ungültig`);
      updates.push(`${key} = ?`); binds.push(v);
    } else {
      updates.push(`${key} = ?`); binds.push(normalize(body[key]));
    }
  }
  if (!updates.length) return err('Keine Änderungen');

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  binds.push(id);

  const row = await env.DB.prepare(`UPDATE einsaetze SET ${updates.join(', ')} WHERE id = ? RETURNING updated_at`).bind(...binds).first();
  return json({ ok: true, updated_at: row?.updated_at ?? null });
}
