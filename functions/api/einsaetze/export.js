// GET /api/export — alle Einsätze inkl. Fahrzeuge/Besatzung/PA/Verunfallte/FFen
// als verschachteltes JSON. Zugriff: Admin oder Leser (isEpReaderAll) — also alle,
// die ohnehin alle Einsätze sehen. Das Frontend baut daraus eine XLSX-Datei.
import { json, err, unauthorized, forbidden, isEpReaderAll } from '../../_lib/auth.js';

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpReaderAll(data.user)) return forbidden();

  const einsaetze = (await env.DB.prepare(
    `SELECT id, alarm_datum, alarm_uhrzeit, alarmierte_einheit, einsatzort, einsatzgrund,
            einsatzleiter, km_einsatzstelle, km_gesamt, erste_ff_id, notizen,
            status, abgeschlossen_at, abgeschlossen_by, created_by, created_at
     FROM einsaetze
     ORDER BY alarm_datum DESC, alarm_uhrzeit DESC, id DESC`
  ).all()).results;

  if (!einsaetze.length) return json({ einsaetze: [] });

  // Alle Kind-Datensätze in wenigen Bulk-Queries (unabhängig von der Anzahl Einsätze).
  const [ffenStamm, ffenVorOrt, fahrzeuge, besatzung, pa, verunfallte] = await Promise.all([
    env.DB.prepare(`SELECT id, kuerzel, name FROM einsatz_ffen_stamm`).all(),
    env.DB.prepare(`SELECT einsatz_id, ff_id FROM einsatz_ffen_vor_ort`).all(),
    env.DB.prepare(
      `SELECT ef.id, ef.einsatz_id, ef.ende_datum, ef.ende_uhrzeit, s.kennung, s.name
       FROM einsatz_fahrzeuge ef
       JOIN einsatz_fahrzeuge_stamm s ON s.id = ef.fahrzeug_id
       ORDER BY s.sort_order, s.name`
    ).all(),
    env.DB.prepare(
      `SELECT einsatz_fahrzeug_id, position, person_vorname, person_nachname
       FROM einsatz_besatzung`
    ).all(),
    env.DB.prepare(
      `SELECT einsatz_id, person_vorname, person_nachname, dauer_minuten
       FROM einsatz_pa ORDER BY sort_order, id`
    ).all(),
    env.DB.prepare(
      `SELECT einsatz_id, kennzeichen FROM einsatz_verunfallte ORDER BY sort_order, id`
    ).all(),
  ]);

  const ffLabel = new Map(ffenStamm.results.map((f) => [f.id, f.kuerzel || f.name]));

  const ffenByEinsatz = groupBy(ffenVorOrt.results, 'einsatz_id', (r) => ffLabel.get(r.ff_id)).map;
  const besByEf = groupBy(besatzung.results, 'einsatz_fahrzeug_id', (b) => ({
    position: b.position, person_vorname: b.person_vorname, person_nachname: b.person_nachname,
  })).map;
  const paByEinsatz = groupBy(pa.results, 'einsatz_id', (p) => ({
    person_vorname: p.person_vorname, person_nachname: p.person_nachname, dauer_minuten: p.dauer_minuten,
  })).map;
  const verByEinsatz = groupBy(verunfallte.results, 'einsatz_id', (v) => v.kennzeichen).map;

  // Fahrzeuge je Einsatz inkl. Besatzung
  const fzByEinsatz = new Map();
  for (const f of fahrzeuge.results) {
    if (!fzByEinsatz.has(f.einsatz_id)) fzByEinsatz.set(f.einsatz_id, []);
    fzByEinsatz.get(f.einsatz_id).push({
      kennung: f.kennung,
      name: f.name,
      ende_datum: f.ende_datum,
      ende_uhrzeit: f.ende_uhrzeit,
      besatzung: besByEf.get(f.id) || [],
    });
  }

  const out = einsaetze.map((e) => ({
    ...e,
    erste_ff_name: e.erste_ff_id ? (ffLabel.get(e.erste_ff_id) || '') : '',
    ffen: ffenByEinsatz.get(e.id) || [],
    fahrzeuge: fzByEinsatz.get(e.id) || [],
    pa: paByEinsatz.get(e.id) || [],
    verunfallte: verByEinsatz.get(e.id) || [],
  }));

  return json({ einsaetze: out });
}

// Gruppiert rows nach key; map(row) liefert den zu sammelnden Wert (null/undefined wird verworfen).
function groupBy(rows, key, map) {
  const m = new Map();
  for (const r of rows) {
    const v = map(r);
    if (v == null) continue;
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(v);
  }
  return { map: m };
}
