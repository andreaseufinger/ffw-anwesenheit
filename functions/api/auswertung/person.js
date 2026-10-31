// GET /api/auswertung/person?person_id=N&abteilung_id=N&von=YYYY-MM-DD&bis=YYYY-MM-DD
//
// Einzelauswertung für eine Person: jeder Termin, an dem sie anwesend war,
// und jeder Einsatz, auf dem sie auf einem Fahrzeug oder unter Atemschutz
// stand. Die Anzeige baut daraus die Liste und den Monatsverlauf.
//
// Dieselben Zugangsregeln wie /api/auswertung. Zusätzlich muss die Person
// zur Abteilung gehören oder an einem ihrer Termine teilgenommen haben —
// sonst könnte ein Abteilungsadmin über eine fremde person_id Teilnahmen
// lesen. Gezeigt werden ohnehin nur Termine DIESER Abteilung; Einsätze nur,
// wenn die Abteilung am Einsatzdienst teilnimmt.
import { json, err, unauthorized, forbidden } from '../../_lib/auth.js';
import { erlaubteAbteilungen, darfAbteilung } from '../../_lib/auth.js';
import { mitStammdaten } from '../../_lib/stammdaten.js';
import { dauerAbend, zuMinuten } from '../../_lib/auswertung.js';
import { darfAuswerten, zeitraumAus } from '../auswertung.js';

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!darfAuswerten(data.user)) return forbidden();

  const params = new URL(request.url).searchParams;
  const { value: zeitraum, error } = zeitraumAus(params);
  if (error) return err(error);

  const personId = Math.trunc(Number(params.get('person_id')));
  const abteilungId = Math.trunc(Number(params.get('abteilung_id')));
  if (!Number.isFinite(personId) || personId <= 0) return err('person_id fehlt oder ungültig');
  if (!Number.isFinite(abteilungId) || abteilungId <= 0) return err('abteilung_id fehlt oder ungültig');

  const erlaubt = await erlaubteAbteilungen(env, data.user);
  if (!darfAbteilung(erlaubt, abteilungId)) return forbidden();

  return mitStammdaten('abteilungen', async () => {
    const { von, bis } = zeitraum;
    const [abt, person] = await Promise.all([
      env.DB.prepare(
        `SELECT id, name, einsatzdienst FROM abteilungen WHERE id = ?`
      ).bind(abteilungId).first(),
      env.DB.prepare(
        // Mitglied ODER Gast: wer an einem Termin dieser Abteilung teilnahm,
        // steht in deren Auswertung und darf dort auch einzeln erscheinen.
        `SELECT p.id, p.nachname, p.vorname, p.aktiv,
                COALESCE(pr.name, CASE WHEN pa.person_id IS NULL THEN 'Teilnehmer' END) AS rolle
         FROM personen p
         LEFT JOIN personen_abteilungen pa ON pa.person_id = p.id AND pa.abteilung_id = ?
         LEFT JOIN personen_rollen pr ON pr.id = pa.rolle_id
         WHERE p.id = ?
           AND (pa.person_id IS NOT NULL OR EXISTS (
             SELECT 1 FROM attendance_entries e
             JOIN attendance_sessions s ON s.id = e.session_id
             WHERE e.person_id = p.id AND s.abteilung_id = ?))`
      ).bind(abteilungId, personId, abteilungId).first(),
    ]);
    if (!abt) return err('Abteilung nicht gefunden', 404);
    if (!person) return err('Person hat mit dieser Abteilung nichts zu tun', 404);

    const mitEinsaetzen = !!abt.einsatzdienst;
    const leer = { results: [] };
    const [abende, angebot, besatzung, pa] = await Promise.all([
      env.DB.prepare(
        `SELECT s.id, s.datum, s.zeit_von, s.zeit_bis, s.dienstart, s.thema,
                COALESCE(d.kategorie, 'sonstiges') AS kategorie
         FROM attendance_entries e
         JOIN attendance_sessions s ON s.id = e.session_id
         LEFT JOIN dienstarten d ON d.name = s.dienstart COLLATE NOCASE
         WHERE e.person_id = ? AND e.status = 'anwesend'
           AND s.abteilung_id = ? AND s.datum BETWEEN ? AND ?
         ORDER BY s.datum DESC, s.zeit_von DESC`
      ).bind(personId, abteilungId, von, bis).all(),

      // Angebotene Übungen je Monat: Nenner für "3 von 4 Übungen"
      env.DB.prepare(
        `SELECT substr(s.datum, 1, 7) AS monat, COUNT(DISTINCT s.id) AS anzahl
         FROM attendance_sessions s
         JOIN dienstarten d ON d.name = s.dienstart COLLATE NOCASE
         WHERE s.abteilung_id = ? AND s.datum BETWEEN ? AND ? AND d.kategorie = 'uebung'
         GROUP BY monat`
      ).bind(abteilungId, von, bis).all(),

      mitEinsaetzen ? env.DB.prepare(
        `SELECT e.id, e.alarm_datum, e.alarm_uhrzeit, e.einsatzgrund, e.einsatzort,
                st.name AS fahrzeug, b.position, f.ende_datum, f.ende_uhrzeit
         FROM einsatz_besatzung b
         JOIN einsatz_fahrzeuge f ON f.id = b.einsatz_fahrzeug_id
         JOIN einsaetze e ON e.id = f.einsatz_id
         LEFT JOIN einsatz_fahrzeuge_stamm st ON st.id = f.fahrzeug_id
         WHERE b.person_id = ? AND e.alarm_datum BETWEEN ? AND ?`
      ).bind(personId, von, bis).all() : leer,

      mitEinsaetzen ? env.DB.prepare(
        `SELECT e.id, e.alarm_datum, e.alarm_uhrzeit, e.einsatzgrund, e.einsatzort,
                a.dauer_minuten
         FROM einsatz_pa a
         JOIN einsaetze e ON e.id = a.einsatz_id
         WHERE a.person_id = ? AND e.alarm_datum BETWEEN ? AND ?`
      ).bind(personId, von, bis).all() : leer,
    ]);

    // Dienstarten können je Abteilung gleich heißen; der Join liefert dann
    // denselben Abend mehrfach.
    const gesehen = new Set();
    const termine = [];
    for (const s of abende.results) {
      if (gesehen.has(s.id)) continue;
      gesehen.add(s.id);
      termine.push({
        id: s.id,
        datum: s.datum,
        zeit_von: s.zeit_von,
        zeit_bis: s.zeit_bis,
        titel: s.thema,
        dienstart: s.dienstart,
        kategorie: s.kategorie,
        minuten: dauerAbend(s.datum, s.zeit_von, s.zeit_bis),
      });
    }

    // Ein Einsatz, auch wenn die Person auf zwei Fahrzeugen und unter PA
    // steht. Stunden bis zum spätesten Ende ihrer Fahrzeuge, wie in der
    // Gesamtauswertung.
    const proEinsatz = new Map();
    const hole = (r) => {
      if (!proEinsatz.has(r.id)) {
        proEinsatz.set(r.id, {
          id: r.id, datum: r.alarm_datum, uhrzeit: r.alarm_uhrzeit,
          titel: r.einsatzgrund || r.einsatzort || 'Einsatz', ort: r.einsatzort || '',
          fahrzeuge: [], pa_minuten: null, ende: null,
        });
      }
      return proEinsatz.get(r.id);
    };
    for (const b of besatzung.results) {
      const e = hole(b);
      e.fahrzeuge.push(`${b.fahrzeug || 'Fahrzeug'} (${b.position})`);
      const ende = zuMinuten(b.ende_datum, b.ende_uhrzeit);
      if (ende !== null && (e.ende === null || ende > e.ende)) e.ende = ende;
    }
    for (const a of pa.results) {
      const e = hole(a);
      e.pa_minuten = (e.pa_minuten || 0) + (a.dauer_minuten || 0);
    }
    const einsaetze = [...proEinsatz.values()].map((e) => {
      const alarm = zuMinuten(e.datum, e.uhrzeit);
      const minuten = (alarm !== null && e.ende !== null && e.ende >= alarm) ? e.ende - alarm : null;
      const { ende, ...rest } = e;
      return { ...rest, minuten };
    }).sort((a, b) => (b.datum + b.uhrzeit).localeCompare(a.datum + a.uhrzeit));

    return json({
      zeitraum,
      person: {
        id: person.id,
        name: `${person.nachname}, ${person.vorname}`,
        aktiv: !!person.aktiv,
        rolle: person.rolle || null,
      },
      abteilung: { id: abt.id, name: abt.name, einsatzdienst: mitEinsaetzen },
      uebungen_angeboten: Object.fromEntries(angebot.results.map((r) => [r.monat, r.anzahl])),
      termine,
      einsaetze,
    });
  });
}
