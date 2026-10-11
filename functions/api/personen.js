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
import { mitStammdaten } from '../_lib/stammdaten.js';

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

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const alle = new URL(request.url).searchParams.get('alle') === '1';
  if (alle && !isAppAdmin(data.user)) return forbidden();

  return mitStammdaten('personen', async () => {
    const { results } = await env.DB.prepare(
      `SELECT id, nachname, vorname, aktiv, eintritt, austritt
       FROM personen
       ${alle ? '' : 'WHERE aktiv = 1'}
       ORDER BY nachname COLLATE NOCASE, vorname COLLATE NOCASE`
    ).all();
    return json(results);
  });
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validatePerson(body);
  if (error) return err(error);

  const vorhanden = await env.DB.prepare(
    `SELECT id FROM personen WHERE nachname = ? COLLATE NOCASE AND vorname = ? COLLATE NOCASE`
  ).bind(value.nachname, value.vorname).first();
  if (vorhanden) return err('Diese Person ist bereits eingetragen', 409);

  const res = await env.DB.prepare(
    `INSERT INTO personen (nachname, vorname, aktiv, eintritt, austritt)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(value.nachname, value.vorname, value.aktiv, value.eintritt, value.austritt).run();

  return json({ id: res.meta.last_row_id, ...value }, { status: 201 });
}
