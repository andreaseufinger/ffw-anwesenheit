// POST /api/personen/:id/zusammenfuehren  { quelle_id }
//
// Führt die Person `quelle_id` in `:id` zusammen. Vorbeugen allein genügt
// nicht — eine entstandene Dublette bliebe sonst für immer zwei Zeilen in der
// Auswertung, mit halbierten Stunden auf beiden.
//
// Nur der übergreifende Admin: der Vorgang greift über Abteilungsgrenzen
// hinweg und löscht einen Datensatz.
//
// Was passiert:
//   1. Zugehörigkeiten vereinigen. Wo beide dieselbe Abteilung haben, bleibt
//      die Rolle des Ziels; fehlt sie dort, wird die der Quelle übernommen.
//   2. person_id in attendance_entries, einsatz_besatzung und einsatz_pa
//      umhängen. Die Namensspalten bleiben unberührt — sie sind die
//      historische Aufzeichnung, nicht die Verknüpfung.
//   3. Mehrfacheinträge einsammeln: haben BEIDE am selben Abend teilgenommen,
//      entstünden zwei Zeilen für eine Person. Dann bleibt die mit dem
//      stärksten Status stehen, der Rest wird entfernt und gemeldet.
//   4. Quelle löschen.
import { json, err, unauthorized, forbidden, isUebergreifenderAdmin } from '../../../_lib/auth.js';

// anwesend schlägt entschuldigt schlägt abwesend schlägt leer.
const RANG = { anwesend: 3, entschuldigt: 2, abwesend: 1, '': 0 };

export async function onRequestPost({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isUebergreifenderAdmin(data.user)) return forbidden();

  const zielId = Number(params.id);
  if (!Number.isFinite(zielId)) return err('Ungültige ID');

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const quelleId = Number(body?.quelle_id);
  if (!Number.isFinite(quelleId)) return err('quelle_id fehlt oder ungültig');
  if (quelleId === zielId) return err('Quelle und Ziel sind dieselbe Person');

  const ziel = await env.DB.prepare(
    `SELECT id, nachname, vorname FROM personen WHERE id = ?`).bind(zielId).first();
  if (!ziel) return err('Ziel-Person nicht gefunden', 404);
  const quelle = await env.DB.prepare(
    `SELECT id, nachname, vorname FROM personen WHERE id = ?`).bind(quelleId).first();
  if (!quelle) return err('Quell-Person nicht gefunden', 404);

  // --- 1. Zugehörigkeiten ------------------------------------------------
  const { results: quellZuord } = await env.DB.prepare(
    `SELECT abteilung_id, von, bis, rolle_id FROM personen_abteilungen WHERE person_id = ?`
  ).bind(quelleId).all();
  const { results: zielZuord } = await env.DB.prepare(
    `SELECT abteilung_id, rolle_id FROM personen_abteilungen WHERE person_id = ?`
  ).bind(zielId).all();
  const zielNach = new Map(zielZuord.map((z) => [z.abteilung_id, z.rolle_id]));

  let zuordNeu = 0, rollenUebernommen = 0;
  for (const z of quellZuord) {
    if (!zielNach.has(z.abteilung_id)) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO personen_abteilungen
           (person_id, abteilung_id, von, bis, rolle_id) VALUES (?, ?, ?, ?, ?)`
      ).bind(zielId, z.abteilung_id, z.von, z.bis, z.rolle_id).run();
      zuordNeu += 1;
    } else if (zielNach.get(z.abteilung_id) === null && z.rolle_id !== null) {
      await env.DB.prepare(
        `UPDATE personen_abteilungen SET rolle_id = ? WHERE person_id = ? AND abteilung_id = ?`
      ).bind(z.rolle_id, zielId, z.abteilung_id).run();
      rollenUebernommen += 1;
    }
  }

  // --- 2. Historie umhängen ----------------------------------------------
  const abende = await env.DB.prepare(
    `UPDATE attendance_entries SET person_id = ? WHERE person_id = ? RETURNING id`
  ).bind(zielId, quelleId).all();
  const besatzung = await env.DB.prepare(
    `UPDATE einsatz_besatzung SET person_id = ? WHERE person_id = ? RETURNING id`
  ).bind(zielId, quelleId).all();
  const pa = await env.DB.prepare(
    `UPDATE einsatz_pa SET person_id = ? WHERE person_id = ? RETURNING id`
  ).bind(zielId, quelleId).all();

  // --- 3. Mehrfacheinträge je Abend einsammeln ---------------------------
  const { results: doppelt } = await env.DB.prepare(
    `SELECT session_id FROM attendance_entries
     WHERE person_id = ?
     GROUP BY session_id HAVING COUNT(*) > 1`
  ).bind(zielId).all();

  let eingesammelt = 0;
  for (const d of doppelt) {
    const { results: zeilen } = await env.DB.prepare(
      `SELECT id, status FROM attendance_entries
       WHERE person_id = ? AND session_id = ?`
    ).bind(zielId, d.session_id).all();
    // Die stärkste Teilnahme behalten — sonst würde eine Anwesenheit durch
    // eine zufällig später einsortierte Abwesenheit verdrängt.
    zeilen.sort((a, b) => (RANG[b.status] ?? 0) - (RANG[a.status] ?? 0));
    for (const weg of zeilen.slice(1)) {
      await env.DB.prepare(`DELETE FROM attendance_entries WHERE id = ?`).bind(weg.id).run();
      eingesammelt += 1;
    }
  }

  // --- 4. Quelle löschen -------------------------------------------------
  await env.DB.prepare(`DELETE FROM personen WHERE id = ?`).bind(quelleId).run();

  return json({
    ok: true,
    ziel: `${ziel.nachname}, ${ziel.vorname}`,
    quelle: `${quelle.nachname}, ${quelle.vorname}`,
    abteilungen_uebernommen: zuordNeu,
    rollen_uebernommen: rollenUebernommen,
    umgehaengt: {
      abende: (abende.results || []).length,
      besatzung: (besatzung.results || []).length,
      atemschutz: (pa.results || []).length,
    },
    // Wenn das größer als 0 ist, waren beide Datensätze am selben Abend
    // eingetragen — dort stand dieselbe Person doppelt in der Liste.
    doppelte_abende_eingesammelt: eingesammelt,
  });
}
