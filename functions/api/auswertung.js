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
import { erlaubteAbteilungen, darfAbteilung } from '../_lib/auth.js';
import { mitStammdaten } from '../_lib/stammdaten.js';
import { auswerten } from '../_lib/auswertung.js';

// Zugang richtet sich nach der Abteilungs-Zuständigkeit, nicht mehr nach der
// Kombination beider Admin-Rollen.
//
// Die alte Regel (admin_anwesenheit UND admin_einsatzprotokoll) stammte daher,
// dass die Auswertung Einsatzdaten enthält. Mit dem Abteilungsadmin, der die
// Einsätze seiner Einsatzabteilung sehen soll, ließ sie sich nicht halten:
// sonst hätte ein Abteilungsadmin mehr gesehen als ein übergreifender
// Anwesenheit-Admin. Einsätze erscheinen weiterhin nur bei Abteilungen mit
// einsatzdienst = 1 — eine Jugendauswertung enthält keine.
export function darfAuswerten(user) {
  return hasRole(user, ROLES.ADMIN_ANWESENHEIT)
      || hasRole(user, ROLES.ABTEILUNGSADMIN_ANWESENHEIT);
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
      error: 'Die Auswertung setzt Admin-Rechte voraus — übergreifend oder '
           + 'für eine Abteilung.',
    }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const { value: zeitraum, error } = zeitraumAus(params);
  if (error) return err(error);

  // Abteilung bestimmen. Ohne Angabe die niedrigste sort_order — dieselbe
  // Vorauswahl wie in der Erfassung. Eine gemischte Auswertung über alle
  // Abteilungen gibt es absichtlich nicht: das Stundensoll unterscheidet
  // sich, und eine Spalte "Einsatz" ist für die Jugend sinnlos.
  const rohAbt = params.get('abteilung_id');
  let abteilungId = null;
  if (rohAbt !== null && rohAbt !== '') {
    const n = Number(rohAbt);
    if (!Number.isFinite(n)) return err('abteilung_id ungültig');
    abteilungId = Math.trunc(n);
    const erlaubt = await erlaubteAbteilungen(env, data.user);
    if (!darfAbteilung(erlaubt, abteilungId)) return forbidden();
  }

  const rohPersonId = params.get('person_id');
  let personIdFilter = null;
  if (rohPersonId !== null && rohPersonId !== '') {
    const n = Number(rohPersonId);
    if (!Number.isFinite(n)) return err('person_id ungültig');
    personIdFilter = Math.trunc(n);
  }

  return mitStammdaten('abteilungen', async () => {
    const { von, bis } = zeitraum;

    // Ohne Angabe die niedrigste sort_order unter den ERLAUBTEN Abteilungen —
    // der Abteilungsadmin landet damit bei seiner eigenen, nicht bei der
    // global ersten.
    let abt;
    if (abteilungId !== null) {
      abt = await env.DB.prepare(
        `SELECT id, name, uebung_soll_stunden, einsatzdienst
         FROM abteilungen WHERE id = ?`).bind(abteilungId).first();
    } else {
      const erlaubt = await erlaubteAbteilungen(env, data.user);
      if (erlaubt === null) {
        abt = await env.DB.prepare(
          `SELECT id, name, uebung_soll_stunden, einsatzdienst
           FROM abteilungen ORDER BY sort_order, id LIMIT 1`).first();
      } else if (erlaubt.length) {
        abt = await env.DB.prepare(
          `SELECT id, name, uebung_soll_stunden, einsatzdienst
           FROM abteilungen WHERE id IN (${erlaubt.map(() => '?').join(', ')})
           ORDER BY sort_order, id LIMIT 1`).bind(...erlaubt).first();
      }
    }
    if (!abt) return err('Keine Abteilung gefunden', 404);

    // Einsätze nur, wenn die Abteilung am Einsatzdienst teilnimmt.
    const mitEinsaetzen = !!abt.einsatzdienst;
    const leer = { results: [] };

    const [personen, abende, teilnehmer, einsaetze, besatzung, pa] = await Promise.all([
      // Nur Mitglieder dieser Abteilung — sonst stünden alle 35 in der
      // Jugendauswertung mit null Teilnahmen.
      env.DB.prepare(
        `SELECT p.id, p.nachname, p.vorname, p.aktiv, pr.name AS rolle
         FROM personen p
         JOIN personen_abteilungen pa ON pa.person_id = p.id
         LEFT JOIN personen_rollen pr ON pr.id = pa.rolle_id
         WHERE pa.abteilung_id = ?
           AND (pa.von IS NULL OR pa.von <= ?)
           AND (pa.bis IS NULL OR pa.bis >= ?)`
      ).bind(abt.id, bis, von).all(),

      // kategorie über den Dienstart-Namen verbinden: attendance_sessions
      // speichert die Dienstart als Freitext. Unbekannte gelten als sonstiges.
      env.DB.prepare(
        `SELECT s.id, s.datum, s.zeit_von, s.zeit_bis, s.dienstart,
                COALESCE(d.kategorie, 'sonstiges') AS kategorie
         FROM attendance_sessions s
         LEFT JOIN dienstarten d ON d.name = s.dienstart COLLATE NOCASE
         WHERE s.datum BETWEEN ? AND ? AND s.abteilung_id = ?`
      ).bind(von, bis, abt.id).all(),

      env.DB.prepare(
        `SELECT e.session_id, e.person_id, e.nachname, e.vorname
         FROM attendance_entries e
         JOIN attendance_sessions s ON s.id = e.session_id
         WHERE s.datum BETWEEN ? AND ? AND s.abteilung_id = ?
           AND e.status = 'anwesend'`
      ).bind(von, bis, abt.id).all(),

      mitEinsaetzen ? env.DB.prepare(
        `SELECT id, alarm_datum, alarm_uhrzeit FROM einsaetze
         WHERE alarm_datum BETWEEN ? AND ?`
      ).bind(von, bis).all() : leer,

      // Endzeit steht pro Fahrzeug, nicht am Einsatz.
      mitEinsaetzen ? env.DB.prepare(
        `SELECT f.einsatz_id, b.person_id, b.person_nachname, b.person_vorname,
                f.ende_datum, f.ende_uhrzeit
         FROM einsatz_besatzung b
         JOIN einsatz_fahrzeuge f ON f.id = b.einsatz_fahrzeug_id
         JOIN einsaetze e ON e.id = f.einsatz_id
         WHERE e.alarm_datum BETWEEN ? AND ?
           AND (b.person_nachname IS NOT NULL OR b.person_vorname IS NOT NULL)`
      ).bind(von, bis).all() : leer,

      mitEinsaetzen ? env.DB.prepare(
        `SELECT a.einsatz_id, a.person_id, a.person_nachname, a.person_vorname
         FROM einsatz_pa a
         JOIN einsaetze e ON e.id = a.einsatz_id
         WHERE e.alarm_datum BETWEEN ? AND ? AND a.person_nachname <> ''`
      ).bind(von, bis).all() : leer,
    ]);

    // Teilnehmer mit Person, die nicht Mitglied der Abteilung sind (Gäste).
    // Ohne diese Liste fielen sie unter "nicht zuordenbar", obwohl die
    // Zuordnung stimmt.
    const mitglieder = new Set(personen.results.map((p) => p.id));
    const fremdeIds = [...new Set(
      [...teilnehmer.results, ...besatzung.results, ...pa.results]
        .map((t) => t.person_id)
        .filter((id) => id !== null && id !== undefined && !mitglieder.has(id))
    )];
    const gaeste = fremdeIds.length ? await env.DB.prepare(
      `SELECT id, nachname, vorname, aktiv FROM personen
       WHERE id IN (${fremdeIds.map(() => '?').join(', ')})`
    ).bind(...fremdeIds).all() : leer;

    const ergebnis = auswerten({
      gaeste:     gaeste.results,
      personen:   personen.results,
      abende:     abende.results,
      teilnehmer: teilnehmer.results,
      einsaetze:  einsaetze.results,
      besatzung:  besatzung.results,
      pa:         pa.results,
    }, personIdFilter, zeitraum, abt);

    return json({ zeitraum, ...ergebnis });
  });
}
