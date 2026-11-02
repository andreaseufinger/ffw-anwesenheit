// PUT    /api/einsaetze/:id/fahrzeuge/:efId — Einsatzende-Zeit und/oder Besatzung
//        eines Fahrzeug-Einsatzes aktualisieren.
//        Body: { ende_datum?, ende_uhrzeit?, besatzung?: [{position, person_vorname, person_nachname}] }
//        Wenn `besatzung` mitgeschickt wird, ersetzt sie die komplette Besatzung
//        dieses Fahrzeugs (pro Fahrzeug last-write-wins, andere Fahrzeuge bleiben unberührt).
// DELETE /api/einsaetze/:id/fahrzeuge/:efId — Fahrzeug aus dem Einsatz entfernen.
import { json, err, unauthorized, forbidden, isEpWriter } from '../../../../_lib/auth.js';
import { loadEditableEinsatz, touchEinsatz, strOrNull } from '../../../einsaetze.js';

async function loadFahrzeugInEinsatz(env, einsatzId, efId) {
  const row = await env.DB.prepare(
    `SELECT id FROM einsatz_fahrzeuge WHERE id = ? AND einsatz_id = ?`
  ).bind(efId, einsatzId).first();
  return row || null;
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const einsatzId = Number(params.id);
  const efId = Number(params.efId);
  if (!Number.isFinite(einsatzId) || !Number.isFinite(efId)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, einsatzId);
  if (editable.error) return editable.error;

  const ef = await loadFahrzeugInEinsatz(env, einsatzId, efId);
  if (!ef) return err('Fahrzeug-Einsatz nicht gefunden', 404);

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  // Partial update von ende_datum / ende_uhrzeit
  const updates = []; const binds = [];
  if ('ende_datum' in body)  { updates.push('ende_datum = ?');  binds.push(strOrNull(body.ende_datum)); }
  if ('ende_uhrzeit' in body){ updates.push('ende_uhrzeit = ?'); binds.push(strOrNull(body.ende_uhrzeit)); }
  if (updates.length) {
    binds.push(efId);
    await env.DB.prepare(`UPDATE einsatz_fahrzeuge SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
  }

  // Besatzung ersetzen, falls mitgeschickt
  // Löschen und Einfügen in EINEM Batch (= eine Transaktion). Getrennt
  // liefen zwei gleichzeitige Speicherungen ineinander (Verlassen des Felds
  // und Änderung feuern beide, zwei Tablets ebenso) und scheiterten an
  // UNIQUE (einsatz_fahrzeug_id, position).
  if (Array.isArray(body?.besatzung)) {
    const stmt = env.DB.prepare(
      `INSERT INTO einsatz_besatzung
         (einsatz_fahrzeug_id, position, person_nachname, person_vorname, person_id)
       VALUES (?, ?, ?, ?, (SELECT p.id FROM personen p WHERE p.nachname = ? COLLATE NOCASE AND p.vorname = ? COLLATE NOCASE))`
    );
    const batch = [env.DB.prepare(`DELETE FROM einsatz_besatzung WHERE einsatz_fahrzeug_id = ?`).bind(efId)];
    for (const b of body.besatzung) {
      const position = String(b?.position || '').trim();
      if (!position) continue;
      const pn = strOrNull(b?.person_nachname);
      const pv = strOrNull(b?.person_vorname);
      if (!pn && !pv) continue;
      batch.push(stmt.bind(efId, position, pn, pv, pn, pv));
    }
    await env.DB.batch(batch);
  }

  const updated_at = await touchEinsatz(env, einsatzId);
  return json({ ok: true, updated_at });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  const einsatzId = Number(params.id);
  const efId = Number(params.efId);
  if (!Number.isFinite(einsatzId) || !Number.isFinite(efId)) return err('Ungültige ID');

  const editable = await loadEditableEinsatz(env, einsatzId);
  if (editable.error) return editable.error;

  const ef = await loadFahrzeugInEinsatz(env, einsatzId, efId);
  if (!ef) return err('Fahrzeug-Einsatz nicht gefunden', 404);

  await env.DB.prepare(`DELETE FROM einsatz_fahrzeuge WHERE id = ?`).bind(efId).run();
  const updated_at = await touchEinsatz(env, einsatzId);
  return json({ ok: true, updated_at });
}
