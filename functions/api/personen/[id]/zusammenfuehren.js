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
//   2. person_id in jeder Tabelle aus PERSONENBEZUG umhängen (Anwesenheit,
//      Einsatzprotokoll, Atemschutz, Kleidung, Namenszuordnungen der
//      Importe). Die Namensspalten bleiben unberührt — sie sind die
//      historische Aufzeichnung, nicht die Verknüpfung.
//   3. Mehrfacheinträge einsammeln: haben BEIDE am selben Abend teilgenommen,
//      entstünden zwei Zeilen für eine Person. Dann bleibt die mit dem
//      stärksten Status stehen, der Rest wird entfernt und gemeldet.
//   4. AGT-Kennzeichen übernehmen, Quelle löschen, Audit-Eintrag.
// Alles in einem Batch, also einer Transaktion.
import { json, err, unauthorized, forbidden, isUebergreifenderAdmin } from '../../../_lib/auth.js';
import { PERSONENBEZUG, bezuegeZaehlen, bezuegeText } from '../../../_lib/personenbezug.js';
import { auditEintrag } from '../../../_lib/audit.js';

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

  // --- Zählen (nur lesen, für die Rückmeldung) ---------------------------
  const zahlen = await bezuegeZaehlen(env, quelleId);
  const { results: zuord } = await env.DB.prepare(
    `SELECT q.abteilung_id, q.rolle_id AS q_rolle, z.person_id AS z_da, z.rolle_id AS z_rolle
     FROM personen_abteilungen q
     LEFT JOIN personen_abteilungen z ON z.person_id = ? AND z.abteilung_id = q.abteilung_id
     WHERE q.person_id = ?`
  ).bind(zielId, quelleId).all();
  const zuordNeu = zuord.filter((z) => z.z_da === null).length;
  const rollenUebernommen = zuord.filter((z) => z.z_da !== null && z.z_rolle === null && z.q_rolle !== null).length;

  // --- Ein Batch = eine Transaktion: alles oder nichts --------------------
  // Vorher liefen die Schritte einzeln; ein Abbruch hinterließ eine halb
  // umgehängte Person. Und Atemschutz und Kleidung fehlten ganz (Befund D1):
  // sie hingen per CASCADE an der Quelle und wurden mit ihr gelöscht.
  const rang = (t) => `CASE ${t}.status WHEN 'anwesend' THEN 3 WHEN 'entschuldigt' THEN 2 WHEN 'abwesend' THEN 1 ELSE 0 END`;
  const schritte = [
    // 1. Zugehörigkeiten: fehlende übernehmen, leere Rolle im Ziel ergänzen
    env.DB.prepare(
      `INSERT OR IGNORE INTO personen_abteilungen (person_id, abteilung_id, von, bis, rolle_id)
       SELECT ?, abteilung_id, von, bis, rolle_id FROM personen_abteilungen WHERE person_id = ?`
    ).bind(zielId, quelleId),
    env.DB.prepare(
      `UPDATE personen_abteilungen SET rolle_id = (
         SELECT q.rolle_id FROM personen_abteilungen q
         WHERE q.person_id = ? AND q.abteilung_id = personen_abteilungen.abteilung_id)
       WHERE person_id = ? AND rolle_id IS NULL AND EXISTS (
         SELECT 1 FROM personen_abteilungen q
         WHERE q.person_id = ? AND q.abteilung_id = personen_abteilungen.abteilung_id AND q.rolle_id IS NOT NULL)`
    ).bind(quelleId, zielId, quelleId),
    // 2. Jede Tabelle mit Personenbezug umhängen. OR IGNORE: hat das Ziel
    //    denselben Eintrag schon (gleicher Florix-Nachweis, eigene Planung),
    //    bleibt der des Ziels; der doppelte der Quelle fällt mit ihr weg.
    ...PERSONENBEZUG.map((b) => env.DB.prepare(
      `UPDATE OR IGNORE ${b.tabelle} SET person_id = ? WHERE person_id = ?`
    ).bind(zielId, quelleId)),
    // 3. Doppelte Teilnahme am selben Abend: die stärkste behalten (bei
    //    Gleichstand die ältere Zeile), sonst würde eine Anwesenheit durch
    //    eine zufällig später einsortierte Abwesenheit verdrängt.
    env.DB.prepare(
      `DELETE FROM attendance_entries AS a
       WHERE a.person_id = ? AND EXISTS (
         SELECT 1 FROM attendance_entries b
         WHERE b.person_id = a.person_id AND b.session_id = a.session_id AND b.id <> a.id
           AND (${rang('b')} > ${rang('a')} OR (${rang('b')} = ${rang('a')} AND b.id < a.id)))`
    ).bind(zielId),
    // 4. AGT-Kennzeichen behalten, wenn eine der beiden es hatte
    env.DB.prepare(
      `UPDATE personen SET agt = MAX(agt, (SELECT agt FROM personen WHERE id = ?)) WHERE id = ?`
    ).bind(quelleId, zielId),
    // 5. Quelle löschen
    env.DB.prepare(`DELETE FROM personen WHERE id = ?`).bind(quelleId),
    auditEintrag(env, data.user, {
      bereich: 'personen', aktion: 'zusammenfuehren', objekt: 'person', objektId: zielId,
      details: { quelle_id: quelleId, quelle: `${quelle.nachname}, ${quelle.vorname}`, umgehaengt: zahlen },
    }),
  ];
  const ergebnis = await env.DB.batch(schritte);
  const eingesammelt = ergebnis[2 + PERSONENBEZUG.length].meta.changes ?? 0;

  return json({
    ok: true,
    ziel: `${ziel.nachname}, ${ziel.vorname}`,
    quelle: `${quelle.nachname}, ${quelle.vorname}`,
    abteilungen_uebernommen: zuordNeu,
    rollen_uebernommen: rollenUebernommen,
    umgehaengt: {
      abende: zahlen.attendance_entries,
      besatzung: zahlen.einsatz_besatzung,
      atemschutz: zahlen.einsatz_pa,
    },
    // Lesbare Zusammenfassung aller umgehängten Daten für die Rückmeldung
    beschreibung: bezuegeText(zahlen),
    // Wenn das größer als 0 ist, waren beide Datensätze am selben Abend
    // eingetragen — dort stand dieselbe Person doppelt in der Liste.
    doppelte_abende_eingesammelt: eingesammelt,
  });
}
