// PUT    /api/personen/:id — Person ändern (Admin)
// DELETE /api/personen/:id — Person entfernen (Admin), nur ohne Historie
//
// Löschen ist absichtlich eng: sobald eine Person in einem Ausbildungsabend
// oder Einsatz auftaucht, würde das Entfernen sie aus den Auswertungen
// vergangener Jahre tilgen, während die Protokolleinträge selbst bestehen
// bleiben. In diesem Fall ist aktiv = 0 der richtige Weg — die Person
// verschwindet aus den Auswahllisten und bleibt in der Statistik.
import { json, err, unauthorized, forbidden, isAppAdmin } from '../../_lib/auth.js';
import { validatePerson } from '../personen.js';

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

async function loadPerson(env, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { error: err('Ungültige ID') };
  const row = await env.DB.prepare(
    `SELECT id, nachname, vorname FROM personen WHERE id = ?`
  ).bind(id).first();
  if (!row) return { error: err('Person nicht gefunden', 404) };
  return { person: row };
}

// Historie wird über die Namen gesucht — eine person_id gibt es in den
// Protokolltabellen noch nicht.
async function historieZaehlen(env, nachname, vorname) {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM attendance_entries
         WHERE nachname = ? COLLATE NOCASE AND vorname = ? COLLATE NOCASE)   AS abende,
       (SELECT COUNT(*) FROM einsatz_besatzung
         WHERE person_nachname = ? COLLATE NOCASE AND person_vorname = ? COLLATE NOCASE) AS besatzung,
       (SELECT COUNT(*) FROM einsatz_pa
         WHERE person_nachname = ? COLLATE NOCASE AND person_vorname = ? COLLATE NOCASE) AS pa`
  ).bind(nachname, vorname, nachname, vorname, nachname, vorname).first();
  const abende = row?.abende ?? 0, besatzung = row?.besatzung ?? 0, pa = row?.pa ?? 0;
  return { abende, besatzung, pa, gesamt: abende + besatzung + pa };
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { person, error: notFound } = await loadPerson(env, params);
  if (notFound) return notFound;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validatePerson(body);
  if (error) return err(error);

  const kollision = await env.DB.prepare(
    `SELECT id FROM personen
     WHERE nachname = ? COLLATE NOCASE AND vorname = ? COLLATE NOCASE AND id != ?`
  ).bind(value.nachname, value.vorname, person.id).first();
  if (kollision) return err('Eine andere Person trägt diesen Namen bereits', 409);

  await env.DB.prepare(
    `UPDATE personen SET nachname = ?, vorname = ?, aktiv = ?, eintritt = ?, austritt = ?
     WHERE id = ?`
  ).bind(value.nachname, value.vorname, value.aktiv, value.eintritt, value.austritt, person.id).run();

  return json({ id: person.id, ...value });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data); if (denied) return denied;
  const { person, error } = await loadPerson(env, params);
  if (error) return error;

  const h = await historieZaehlen(env, person.nachname, person.vorname);
  if (h.gesamt > 0) {
    return json({
      error: 'Person hat Historie und kann nicht gelöscht werden — '
           + 'stattdessen auf „nicht aktiv" setzen',
      historie: h,
    }, { status: 409 });
  }

  await env.DB.prepare(`DELETE FROM personen WHERE id = ?`).bind(person.id).run();
  return json({ ok: true, id: person.id });
}
