// GET  /api/personen — Teilnehmerliste (eingeloggte Benutzer)
//                      ?alle=1 liefert auch ausgetretene (nur Admin)
// POST /api/personen — neue Person anlegen (Admin)
//
// Die Liste lag früher als Datei im Repo (functions/_data/personen.json, in
// zwei Kopien je App) und war damit nur per Deploy änderbar. Sie liegt jetzt
// in D1 und wird von beiden Apps aus derselben Tabelle gelesen.
//
// Ausgetretene Personen werden nicht gelöscht, sondern auf aktiv = 0 gesetzt:
// sie verschwinden aus den Auswahllisten, bleiben aber für Auswertungen
// vergangener Jahre erhalten.
import { json, err, unauthorized, forbidden, isAppAdmin } from '../_lib/auth.js';
import { erlaubteAbteilungen, darfAbteilung, darfVerwalten,
         darfIrgendwasVerwalten } from '../_lib/auth.js';
import { mitStammdaten } from '../_lib/stammdaten.js';
import { findeAehnliche } from '../_lib/namen.js';

// Abteilungs-Zuordnungen aus dem Body lesen. Akzeptiert die neue Form
// [{abteilung_id, rolle_id}] und die alte [id, id] — letztere dann ohne Rolle.
export function normalisiereZuordnungen(body) {
  if (Array.isArray(body?.abteilungen)) {
    return body.abteilungen
      .map((z) => ({
        abteilung_id: Number(z?.abteilung_id),
        rolle_id: z?.rolle_id === undefined || z?.rolle_id === null || z?.rolle_id === ''
          ? null : Number(z.rolle_id),
      }))
      .filter((z) => Number.isFinite(z.abteilung_id));
  }
  if (Array.isArray(body?.abteilung_ids)) {
    return body.abteilung_ids
      .map(Number).filter(Number.isFinite)
      .map((id) => ({ abteilung_id: id, rolle_id: null }));
  }
  return [];
}

export function validatePerson(body) {
  const nachname = String(body?.nachname || '').trim();
  const vorname  = String(body?.vorname  || '').trim();
  if (!nachname) return { error: 'Nachname fehlt' };
  if (!vorname)  return { error: 'Vorname fehlt' };
  if (nachname.length > 80 || vorname.length > 80) return { error: 'Name zu lang (max. 80 Zeichen)' };

  const datum = (v, feld) => {
    if (v === undefined || v === null || v === '') return { wert: null };
    const s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: `${feld} muss ein Datum sein (JJJJ-MM-TT)` };
    return { wert: s };
  };
  const ein = datum(body?.eintritt, 'Eintritt'); if (ein.error) return { error: ein.error };
  const aus = datum(body?.austritt, 'Austritt'); if (aus.error) return { error: aus.error };
  if (ein.wert && aus.wert && aus.wert < ein.wert) {
    return { error: 'Austritt liegt vor dem Eintritt' };
  }

  return {
    value: {
      nachname, vorname,
      aktiv: body?.aktiv === undefined ? 1 : (body.aktiv ? 1 : 0),
      eintritt: ein.wert, austritt: aus.wert,
    },
  };
}

// Personen mit ihren Abteilungen und Rollen, für Suche und Dublettenprüfung.
// Bewusst ÜBER ALLE ABTEILUNGEN: wer eine Dublette vermeiden soll, muss auch
// die Personen sehen können, die in fremden Abteilungen schon existieren.
// Geliefert werden nur Name und Zugehörigkeit, keine weiteren Daten.
async function alleNamen(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.nachname, p.vorname, p.aktiv,
            (SELECT GROUP_CONCAT(a.name, ', ')
               FROM personen_abteilungen pa
               JOIN abteilungen a ON a.id = pa.abteilung_id
              WHERE pa.person_id = p.id) AS abteilungen_namen,
            (SELECT GROUP_CONCAT(pa2.abteilung_id, ',')
               FROM personen_abteilungen pa2 WHERE pa2.person_id = p.id) AS abteilungen_csv
     FROM personen p`
  ).all();
  for (const r of results) {
    r.abteilung_ids = r.abteilungen_csv
      ? r.abteilungen_csv.split(',').map(Number).filter(Number.isFinite) : [];
    delete r.abteilungen_csv;
  }
  return results;
}

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const params = new URL(request.url).searchParams;
  const alle = params.get('alle') === '1';
  if (alle && !darfIrgendwasVerwalten(data.user)) return forbidden();

  // Ohne abteilung_id wie bisher alle Personen — die Auswertung und die
  // Personenverwaltung brauchen das. Mit abteilung_id nur deren Mitglieder,
  // das ist die Teilnehmerliste der Erfassung.
  // ?suche=Name — Dublettensuche über ALLE Abteilungen, für Verwalter.
  // Ohne diesen Weg könnte ein Jugendwart nicht erkennen, dass eine Person
  // in der Einsatzabteilung längst existiert.
  const suche = String(params.get('suche') || '').trim();
  if (suche) {
    if (!darfIrgendwasVerwalten(data.user)) return forbidden();
    return mitStammdaten('personen', async () => {
      const alle = await alleNamen(env);
      const teile = suche.split(/\s+/).filter(Boolean);
      const treffer = alle.filter((p) => {
        const voll = `${p.nachname} ${p.vorname}`.toLowerCase();
        return teile.every((t) => voll.includes(t.toLowerCase()));
      });
      treffer.sort((a, b) =>
        a.nachname.localeCompare(b.nachname, 'de') || a.vorname.localeCompare(b.vorname, 'de'));
      return json(treffer.slice(0, 20));
    });
  }

  const rohAbt = params.get('abteilung_id');
  let abteilungId = null;
  if (rohAbt !== null && rohAbt !== '') {
    const n = Number(rohAbt);
    if (!Number.isFinite(n)) return err('abteilung_id ungültig');
    abteilungId = Math.trunc(n);
    const erlaubt = await erlaubteAbteilungen(env, data.user);
    if (!darfAbteilung(erlaubt, abteilungId)) return forbidden();
  }

  return mitStammdaten('personen', async () => {
    const bedingungen = [];
    const binds = [];
    if (!alle) bedingungen.push('p.aktiv = 1');
    if (abteilungId !== null) {
      // von/bis berücksichtigen, falls gesetzt: ein Übertritt zum 1.7. soll
      // die Person vorher nicht in der neuen Abteilung zeigen.
      bedingungen.push(`EXISTS (SELECT 1 FROM personen_abteilungen pa
         WHERE pa.person_id = p.id AND pa.abteilung_id = ?
           AND (pa.von IS NULL OR pa.von <= DATE('now'))
           AND (pa.bis IS NULL OR pa.bis >= DATE('now')))`);
      binds.push(abteilungId);
    }
    const where = bedingungen.length ? 'WHERE ' + bedingungen.join(' AND ') : '';
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.nachname, p.vorname, p.aktiv, p.eintritt, p.austritt, p.agt,
              (SELECT GROUP_CONCAT(pa2.abteilung_id, ',')
                 FROM personen_abteilungen pa2 WHERE pa2.person_id = p.id) AS abteilungen_csv,
              -- abteilung:rolle-Paare, damit der Dialog je Abteilung die
              -- richtige Rolle vorbelegen kann. 0 = keine Rolle gesetzt.
              (SELECT GROUP_CONCAT(pa3.abteilung_id || ':' || COALESCE(pa3.rolle_id, 0), ',')
                 FROM personen_abteilungen pa3 WHERE pa3.person_id = p.id) AS rollen_csv
       FROM personen p
       ${where}
       ORDER BY p.nachname COLLATE NOCASE, p.vorname COLLATE NOCASE`
    ).bind(...binds).all();
    for (const r of results) {
      r.abteilung_ids = r.abteilungen_csv
        ? r.abteilungen_csv.split(',').map(Number).filter(Number.isFinite) : [];
      delete r.abteilungen_csv;
      r.abteilungen = (r.rollen_csv ? r.rollen_csv.split(',') : [])
        .map((paar) => {
          const [a, rolle] = paar.split(':').map(Number);
          return { abteilung_id: a, rolle_id: rolle || null };
        })
        .filter((x) => Number.isFinite(x.abteilung_id));
      delete r.rollen_csv;
    }
    return json(results);
  });
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!darfIrgendwasVerwalten(data.user)) return forbidden();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validatePerson(body);
  if (error) return err(error);

  // Eine Person ohne Abteilung wäre nirgends in einer Teilnehmerliste.
  // Ohne Angabe die einzige, für die der Benutzer zuständig ist.
  const erlaubt = await erlaubteAbteilungen(env, data.user);
  // Neue Form: [{abteilung_id, rolle_id}]. Die alte Form abteilung_ids bleibt
  // als Rückfall erhalten, dann ohne Rolle.
  let zuordnungen = normalisiereZuordnungen(body);
  if (!zuordnungen.length && erlaubt !== null && erlaubt.length === 1) {
    zuordnungen = [{ abteilung_id: erlaubt[0], rolle_id: null }];
  }
  if (!zuordnungen.length) return err('Mindestens eine Abteilung erforderlich');
  for (const z of zuordnungen) {
    if (!(await darfVerwalten(env, data.user, z.abteilung_id))) return forbidden();
  }

  const alle = await alleNamen(env);

  const vorhanden = alle.find((p) =>
    p.nachname.toLowerCase() === value.nachname.toLowerCase()
    && p.vorname.toLowerCase() === value.vorname.toLowerCase());
  if (vorhanden) {
    // Nicht nur ablehnen, sondern den Ausweg mitgeben: die bestehende Person
    // samt Abteilungen, damit die Oberfläche "Abteilung hinzufügen" anbieten
    // kann statt den Benutzer in eine Namensvariante zu treiben.
    return json({
      error: 'Diese Person ist bereits eingetragen',
      vorhanden: {
        id: vorhanden.id,
        nachname: vorhanden.nachname, vorname: vorhanden.vorname,
        abteilungen_namen: vorhanden.abteilungen_namen,
        abteilung_ids: vorhanden.abteilung_ids,
      },
    }, { status: 409 });
  }

  // Schreibvarianten: "Schuetz" statt "Schütz", ein Leerzeichen zu viel.
  // Warnung, keine Sperre — es gibt echte Namenspaare, die sich gefaltet
  // gleichen. Mit trotzdem_anlegen = true wird sie übergangen.
  if (!body?.trotzdem_anlegen) {
    const aehnlich = findeAehnliche(alle, value.nachname, value.vorname);
    if (aehnlich.length) {
      return json({
        error: 'Es gibt bereits eine Person mit sehr ähnlichem Namen',
        aehnlich: aehnlich.map((p) => ({
          id: p.id, nachname: p.nachname, vorname: p.vorname,
          abteilungen_namen: p.abteilungen_namen,
          abteilung_ids: p.abteilung_ids,
        })),
      }, { status: 409 });
    }
  }

  const res = await env.DB.prepare(
    `INSERT INTO personen (nachname, vorname, aktiv, eintritt, austritt)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(value.nachname, value.vorname, value.aktiv, value.eintritt, value.austritt).run();
  const personId = res.meta.last_row_id;

  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO personen_abteilungen (person_id, abteilung_id, rolle_id)
     VALUES (?, ?, ?)`
  );
  await env.DB.batch(zuordnungen.map((z) => stmt.bind(personId, z.abteilung_id, z.rolle_id)));

  return json({
    id: personId, ...value,
    abteilung_ids: zuordnungen.map((z) => z.abteilung_id),
    abteilungen: zuordnungen,
  }, { status: 201 });
}
