// GET    /api/einsaetze/:id — Detail inkl. Status, Fahrzeuge/Besatzung/PA/Verunfallte
// (Den Komplett-Ersatz per PUT gibt es nicht mehr; Änderungen laufen über
//  die Endpunkte unter /api/einsaetze/:id/…, siehe Review-Befund S4.)
// DELETE /api/einsaetze/:id — löschen (Admin)
import { json, err, unauthorized, forbidden, isEpAdmin, isEpReaderAll } from '../../_lib/auth.js';
import { protokolliere, auditEintrag } from '../../_lib/audit.js';

export async function onRequestGet({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const e = await env.DB.prepare(
    `SELECT id, alarm_datum, alarm_uhrzeit, einsatzort, einsatzgrund, einsatzleiter,
            km_einsatzstelle, km_gesamt, erste_ff_id, notizen, alarmierte_einheit,
            status, abgeschlossen_at, abgeschlossen_by,
            created_by, created_at, updated_at, migriert_quelle
     FROM einsaetze WHERE id = ?`
  ).bind(id).first();
  if (!e) return err('Nicht gefunden', 404);

  // Admin und Leser dürfen jeden Einsatz sehen. Erfasser: eigene + alle offenen
  // (für gemeinsame Bearbeitung).
  if (!isEpReaderAll(data.user)
      && e.created_by !== data.user.username
      && e.status !== 'offen') {
    return forbidden();
  }

  const [ffenVorOrt, fahrzeuge, pa, verunfallte] = await Promise.all([
    env.DB.prepare(`SELECT ff_id FROM einsatz_ffen_vor_ort WHERE einsatz_id = ?`).bind(id).all(),
    env.DB.prepare(
      `SELECT ef.id, ef.fahrzeug_id, ef.ende_datum, ef.ende_uhrzeit,
              s.kennung, s.name, s.positionen
       FROM einsatz_fahrzeuge ef
       JOIN einsatz_fahrzeuge_stamm s ON s.id = ef.fahrzeug_id
       WHERE ef.einsatz_id = ?
       ORDER BY s.sort_order, s.name`
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT id, person_nachname, person_vorname, dauer_minuten
       FROM einsatz_pa WHERE einsatz_id = ? ORDER BY sort_order, id`
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT id, kennzeichen FROM einsatz_verunfallte WHERE einsatz_id = ? ORDER BY sort_order, id`
    ).bind(id).all(),
  ]);

  const fahrzeugIds = fahrzeuge.results.map((r) => r.id);
  let besatzungByEf = new Map();
  if (fahrzeugIds.length) {
    const placeholders = fahrzeugIds.map(() => '?').join(',');
    const bRows = await env.DB.prepare(
      `SELECT id, einsatz_fahrzeug_id, position, person_nachname, person_vorname
       FROM einsatz_besatzung
       WHERE einsatz_fahrzeug_id IN (${placeholders})`
    ).bind(...fahrzeugIds).all();
    for (const row of bRows.results) {
      if (!besatzungByEf.has(row.einsatz_fahrzeug_id)) besatzungByEf.set(row.einsatz_fahrzeug_id, []);
      besatzungByEf.get(row.einsatz_fahrzeug_id).push({
        id: row.id,
        position: row.position,
        person_nachname: row.person_nachname,
        person_vorname: row.person_vorname,
      });
    }
  }

  for (const f of fahrzeuge.results) {
    try { f.positionen = JSON.parse(f.positionen); } catch { f.positionen = []; }
    f.besatzung = besatzungByEf.get(f.id) || [];
  }

  return json({
    ...e,
    ff_ids: ffenVorOrt.results.map((r) => r.ff_id),
    fahrzeuge: fahrzeuge.results,
    pa: pa.results,
    verunfallte: verunfallte.results,
  });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpAdmin(data.user)) return forbidden();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const alt = await env.DB.prepare(`SELECT alarm_datum, alarm_uhrzeit, einsatzgrund, status FROM einsaetze WHERE id = ?`).bind(id).first();
  if (!alt) return err('Nicht gefunden', 404);
  await env.DB.prepare(`DELETE FROM einsaetze WHERE id = ?`).bind(id).run();
  await protokolliere(env, data.user, { bereich: 'einsatzprotokoll', aktion: 'loeschen', objekt: 'einsatz', objektId: id, details: alt });
  return json({ ok: true });
}
