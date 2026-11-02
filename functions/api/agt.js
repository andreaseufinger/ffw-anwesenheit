// GET /api/agt — Übersicht Atemschutz: alle Personen mit AGT-Kennzeichen,
// je Spalte der maßgebliche Nachweis und sein Status, dazu der Florix-Stand.
//
// Vorher werden Atemschutzeinsätze aus dem Einsatzprotokoll übernommen
// (einsatz_pa mit Personenbezug). Der Abgleich ist idempotent über
// UNIQUE (person, art, quelle, quelle_ref) und läuft bei jedem Aufruf, damit
// es keinen eigenen Auslöser im Einsatzprotokoll braucht.
import { json, unauthorized, forbidden, darfAtemschutz } from '../_lib/auth.js';
import { istFehlendeTabelle } from '../_lib/stammdaten.js';
import { personStatus, regelnAus, heuteBerlin, SPALTEN, schlechtester, GUELTIG_SQL } from '../_lib/agt.js';
import { kleidungStatus } from '../_lib/kleidung.js';
import { TEILE_SQL } from './kleidung.js';

// Fehlen die Tabellen (Code vor der Migration ausgeliefert), eine Meldung,
// die sagt, was zu tun ist, statt eines generischen 500.
export async function mitAtemschutz(fn) {
  try {
    return await fn();
  } catch (e) {
    if (/no such column: (pass_pflicht|florix_pflicht)/i.test(String(e?.message))) {
      return json({
        error: 'Die Einstellungen der Tauglichkeiten fehlen — die Migration '
             + '2026-10-29_tauglichkeiten.sql wurde noch nicht ausgeführt.',
        migration_fehlt: true,
      }, { status: 503 });
    }
    if (istFehlendeTabelle(e) || /no such column: (p\.|pe\.)?agt/i.test(String(e?.message))) {
      return json({
        error: 'Die Tabellen des Moduls Atemschutz fehlen — die Migration '
             + '2026-10-26_atemschutz.sql wurde noch nicht ausgeführt.',
        migration_fehlt: true,
      }, { status: 503 });
    }
    throw e;
  }
}

// Automatische Nachweise abgleichen. Idempotent über
// UNIQUE (person, art, quelle, quelle_ref); verworfene Einträge bleiben
// stehen und werden so nicht neu angelegt. Ist die Quelle verschwunden
// (Person aus PA-Liste entfernt, Zusatzinfo am Teilnehmer abgewählt),
// fällt der Nachweis wieder weg — außer jemand hat ihn schon abgehakt.
export async function einsaetzeUebernehmen(env) {
  await env.DB.batch([
    // Automatische Nachweise folgen der Frist aus "Tauglichkeiten verwalten"
    env.DB.prepare(
      `UPDATE agt_nachweise SET gueltig_bis = ${GUELTIG_SQL('datum', '(SELECT a.frist_monate FROM agt_arten a WHERE a.art = agt_nachweise.art)')}
       WHERE quelle IN ('anwesenheit', 'einsatz') AND datum IS NOT NULL
         AND (SELECT a.frist_monate FROM agt_arten a WHERE a.art = agt_nachweise.art) IS NOT NULL
         AND gueltig_bis IS NOT ${GUELTIG_SQL('datum', '(SELECT a.frist_monate FROM agt_arten a WHERE a.art = agt_nachweise.art)')}`),
    env.DB.prepare(
      `INSERT OR IGNORE INTO agt_nachweise
         (person_id, art, datum, gueltig_bis, quelle, quelle_ref, created_by)
       SELECT DISTINCT p.person_id, 'einsatz', e.alarm_datum,
              ${GUELTIG_SQL('e.alarm_datum', 'a.frist_monate')},
              'einsatz', CAST(e.id AS TEXT), 'einsatzprotokoll'
       FROM einsatz_pa p
       JOIN einsaetze e ON e.id = p.einsatz_id
       JOIN personen pe ON pe.id = p.person_id AND pe.agt = 1
       JOIN agt_arten a ON a.art = 'einsatz'
       WHERE p.person_id IS NOT NULL`),
    env.DB.prepare(
      `DELETE FROM agt_nachweise
       WHERE quelle = 'einsatz' AND verworfen = 0 AND pass = 0 AND florix = 0
         AND NOT EXISTS (SELECT 1 FROM einsatz_pa p
                         WHERE p.person_id = agt_nachweise.person_id
                           AND p.einsatz_id = CAST(agt_nachweise.quelle_ref AS INTEGER))`),
    env.DB.prepare(
      `INSERT OR IGNORE INTO agt_nachweise
         (person_id, art, datum, gueltig_bis, quelle, quelle_ref, created_by)
       SELECT DISTINCT e.person_id, t.agt_art, s.datum,
              ${GUELTIG_SQL('s.datum', 'a.frist_monate')},
              'anwesenheit', CAST(s.id AS TEXT), 'anwesenheit'
       FROM attendance_entries e
       JOIN attendance_sessions s ON s.id = e.session_id
       JOIN attendance_entry_tags et ON et.entry_id = e.id
       JOIN tags t ON t.id = et.tag_id AND t.agt_art IS NOT NULL
       JOIN agt_arten a ON a.art = t.agt_art
       JOIN personen pe ON pe.id = e.person_id AND pe.agt = 1
       WHERE e.status = 'anwesend'`),
    env.DB.prepare(
      `DELETE FROM agt_nachweise
       WHERE quelle = 'anwesenheit' AND verworfen = 0 AND pass = 0 AND florix = 0
         AND NOT EXISTS (
           SELECT 1 FROM attendance_entries e
           JOIN attendance_entry_tags et ON et.entry_id = e.id
           JOIN tags t ON t.id = et.tag_id
           WHERE e.person_id = agt_nachweise.person_id AND e.status = 'anwesend'
             AND e.session_id = CAST(agt_nachweise.quelle_ref AS INTEGER)
             AND t.agt_art = agt_nachweise.art)`),
  ]);
}

// Geplanter Streckendurchgang ist erledigt, sobald ein Streckennachweis am
// oder nach dem geplanten Datum vorliegt. Florix liefert nur das Ablaufdatum:
// dort zählt, ob es mindestens so weit reicht wie Datum + Frist - 1 Tag.
export async function planungAufraeumen(env) {
  await env.DB.prepare(
    `DELETE FROM agt_planung WHERE EXISTS (
       SELECT 1 FROM agt_nachweise n WHERE n.person_id = agt_planung.person_id
         AND n.art = 'strecke' AND n.verworfen = 0
         AND (n.datum >= agt_planung.datum
              OR (n.datum IS NULL AND n.gueltig_bis >= ${GUELTIG_SQL('agt_planung.datum',
                   "(SELECT frist_monate FROM agt_arten WHERE art = 'strecke')")})))`
  ).run();
}

// Zeilen der Übersicht. Gemeinsam für /api/agt und die Startseite, damit
// beide dieselben Zahlen zeigen.
export async function agtUebersicht(env) {
  await einsaetzeUebernehmen(env);
  const [personen, nachweise, arten, stand] = await Promise.all([
    env.DB.prepare(
      `SELECT id, nachname, vorname, aktiv FROM personen WHERE agt = 1
       ORDER BY nachname COLLATE NOCASE, vorname COLLATE NOCASE`
    ).all(),
    env.DB.prepare(
      `SELECT n.id, n.person_id, n.art, n.datum, n.gueltig_bis, n.quelle,
              n.pass, n.florix
       FROM agt_nachweise n JOIN personen p ON p.id = n.person_id
       WHERE p.agt = 1 AND n.verworfen = 0`
    ).all(),
    env.DB.prepare(`SELECT art, name, gruppe, frist_monate, pass_pflicht, florix_pflicht FROM agt_arten ORDER BY sort_order`).all(),
    env.DB.prepare(
      `SELECT stichtag, importiert_at, importiert_by FROM agt_importe ORDER BY id DESC LIMIT 1`
    ).first(),
  ]);

  // Kleidung der AGT: nur Arten, die für den Kleidungsstatus zählen
  // (HuPF 1, HuPF 4, Handschuhe, Haube; in der Artikelliste änderbar).
  // Ohne Modul Kleidung (Migration fehlt) bleibt die Spalte leer.
  let kleidungTeile = [];
  try {
    kleidungTeile = (await env.DB.prepare(`${TEILE_SQL}
      WHERE t.im_bestand = 1 AND a.agt_relevant = 1 AND p.agt = 1`).all()).results;
  } catch (e) {
    if (!istFehlendeTabelle(e)) throw e;
  }

  // Planung Atemschutzstrecke. Ohne Migration bleibt sie leer.
  const planung = new Map();
  let termine = [];
  try {
    await planungAufraeumen(env);
    const [pl, te] = await Promise.all([
      env.DB.prepare(
        `SELECT p.person_id, p.datum, p.termin_id, t.uhrzeit, t.kunden, t.art
         FROM agt_planung p LEFT JOIN agt_strecke_termine t ON t.id = p.termin_id`).all(),
      env.DB.prepare(`SELECT id, datum, uhrzeit, kunden, art FROM agt_strecke_termine ORDER BY datum, uhrzeit`).all(),
    ]);
    for (const r of pl.results) planung.set(r.person_id, r);
    termine = te.results;
  } catch (e) {
    if (!istFehlendeTabelle(e)) throw e;
  }

  const heute = heuteBerlin();
  const regeln = regelnAus(arten.results);
  const proPerson = new Map();
  for (const n of nachweise.results) {
    if (!proPerson.has(n.person_id)) proPerson.set(n.person_id, []);
    proPerson.get(n.person_id).push(n);
  }
  const zeilen = personen.results.map((p) => {
    const st = personStatus(proPerson.get(p.id) || [], heute, regeln);
    const teile = kleidungTeile.filter((t) => t.person_id === p.id);
    const kleidung = { ...kleidungStatus(teile, heute),
      liste: teile.map((t) => ({ artikelart: t.artikelart, barcode: t.barcode,
        letzte_reinigung: t.letzte_reinigung, in_reinigung_seit: t.in_reinigung_seit })) };
    // Gesamt: schlechtester Wert der Zeile, Kleidung nur mit bekanntem Status
    const gesamt = kleidung.status === 'unbekannt' ? st.gesamt : schlechtester([st.gesamt, kleidung.status]);
    const plan = planung.get(p.id) || null;
    return {
      id: p.id, name: `${p.nachname}, ${p.vorname}`, aktiv: !!p.aktiv,
      spalten: st.spalten, kleidung, gesamt, tauglich: gesamt !== 'rot', planung: plan,
    };
  });

  return { heute, arten: arten.results, florix_stand: stand || null, personen: zeilen, termine };
}

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();

  return mitAtemschutz(async () => {
    const u = await agtUebersicht(env);
    return json({
      heute: u.heute,
      spalten: SPALTEN.map(({ key, name, arten: a }) => ({ key, name, arten: a })),
      arten: u.arten,
      florix_stand: u.florix_stand,
      personen: u.personen,
      termine: u.termine,
    });
  });
}
