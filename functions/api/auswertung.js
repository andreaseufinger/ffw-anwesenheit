// GET /api/auswertung?von=YYYY-MM-DD&bis=YYYY-MM-DD&person_id=N
//
// Teilnahmen und Stunden je Person über BEIDE Apps: Ausbildungsabende aus
// der Anwesenheit-App, Einsätze aus dem Einsatzprotokoll.
//
// Zugang nur für Benutzer, die Admin in BEIDEN Apps sind. Die Auswertung
// enthält Einsatzdaten; ein reiner Anwesenheit-Admin soll sie nicht sehen.
//
// Der Zeitraum wird über das Datum des Termins gefiltert (attendance_sessions
// .datum bzw. einsaetze.alarm_datum), nicht über das Erfassungsdatum.
import { json, err, unauthorized, forbidden, ROLES, hasRole } from '../_lib/auth.js';
import { mitStammdaten } from '../_lib/stammdaten.js';
import { auswerten } from '../_lib/auswertung.js';

function darfAuswerten(user) {
  return hasRole(user, ROLES.ADMIN_ANWESENHEIT)
      && hasRole(user, ROLES.ADMIN_EINSATZPROTOKOLL);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function zeitraumAus(params) {
  const von = String(params.get('von') || '').trim();
  const bis = String(params.get('bis') || '').trim();

  // Ohne Angabe: laufendes Kalenderjahr.
  if (!von && !bis) {
    const jahr = new Date().getUTCFullYear();
    return { value: { von: `${jahr}-01-01`, bis: `${jahr}-12-31` } };
  }
  if (!ISO.test(von) || !ISO.test(bis)) {
    return { error: 'von und bis müssen Datumsangaben sein (JJJJ-MM-TT)' };
  }
  if (bis < von) return { error: 'bis liegt vor von' };
  return { value: { von, bis } };
}

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!darfAuswerten(data.user)) {
    return json({
      error: 'Die Auswertung umfasst Einsatzdaten und setzt Admin-Rechte in '
           + 'beiden Apps voraus.',
    }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const { value: zeitraum, error } = zeitraumAus(params);
  if (error) return err(error);

  const rohPersonId = params.get('person_id');
  let personIdFilter = null;
  if (rohPersonId !== null && rohPersonId !== '') {
    const n = Number(rohPersonId);
    if (!Number.isFinite(n)) return err('person_id ungültig');
    personIdFilter = Math.trunc(n);
  }

  return mitStammdaten('personen', async () => {
    const { von, bis } = zeitraum;

    const [personen, abende, teilnehmer, einsaetze, besatzung, pa] = await Promise.all([
      env.DB.prepare(
        `SELECT id, nachname, vorname, aktiv FROM personen`
      ).all(),

      // kategorie über den Dienstart-Namen verbinden: attendance_sessions
      // speichert die Dienstart als Freitext. Unbekannte gelten als sonstiges.
      env.DB.prepare(
        `SELECT s.id, s.datum, s.zeit_von, s.zeit_bis, s.dienstart,
                COALESCE(d.kategorie, 'sonstiges') AS kategorie
         FROM attendance_sessions s
         LEFT JOIN dienstarten d ON d.name = s.dienstart COLLATE NOCASE
         WHERE s.datum BETWEEN ? AND ?`
      ).bind(von, bis).all(),

      env.DB.prepare(
        `SELECT e.session_id, e.person_id, e.nachname, e.vorname
         FROM attendance_entries e
         JOIN attendance_sessions s ON s.id = e.session_id
         WHERE s.datum BETWEEN ? AND ? AND e.status = 'anwesend'`
      ).bind(von, bis).all(),

      env.DB.prepare(
        `SELECT id, alarm_datum, alarm_uhrzeit FROM einsaetze
         WHERE alarm_datum BETWEEN ? AND ?`
      ).bind(von, bis).all(),

      // Endzeit steht pro Fahrzeug, nicht am Einsatz.
      env.DB.prepare(
        `SELECT f.einsatz_id, b.person_id, b.person_nachname, b.person_vorname,
                f.ende_datum, f.ende_uhrzeit
         FROM einsatz_besatzung b
         JOIN einsatz_fahrzeuge f ON f.id = b.einsatz_fahrzeug_id
         JOIN einsaetze e ON e.id = f.einsatz_id
         WHERE e.alarm_datum BETWEEN ? AND ?
           AND (b.person_nachname IS NOT NULL OR b.person_vorname IS NOT NULL)`
      ).bind(von, bis).all(),

      env.DB.prepare(
        `SELECT a.einsatz_id, a.person_id, a.person_nachname, a.person_vorname
         FROM einsatz_pa a
         JOIN einsaetze e ON e.id = a.einsatz_id
         WHERE e.alarm_datum BETWEEN ? AND ? AND a.person_nachname <> ''`
      ).bind(von, bis).all(),
    ]);

    const ergebnis = auswerten({
      personen:   personen.results,
      abende:     abende.results,
      teilnehmer: teilnehmer.results,
      einsaetze:  einsaetze.results,
      besatzung:  besatzung.results,
      pa:         pa.results,
    }, personIdFilter);

    return json({ zeitraum, ...ergebnis });
  });
}
