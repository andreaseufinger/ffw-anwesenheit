// POST   /api/personen/:id/abteilung — eigene Abteilung zu einer bestehenden
//                                      Person hinzufügen
// DELETE /api/personen/:id/abteilung?abteilung_id=N — wieder entfernen
//
// Schließt die Lücke, die das Abteilungs-Scoping aufgerissen hatte: ein
// Jugendwart sah ein Mitglied der Einsatzabteilung in der Liste, konnte es
// aber nicht bearbeiten (403, weil noch in keiner seiner Abteilungen) und
// nicht neu anlegen (409, existiert bereits). Er kam nicht weiter — und der
// nächste Schritt wäre "Wart, Jutta M." gewesen, also genau die Dublette, die
// kein UNIQUE mehr fängt.
//
// Absichtlich eng: hier lässt sich AUSSCHLIESSLICH eine Zugehörigkeit zu einer
// Abteilung setzen oder entfernen, für die der Aufrufer zuständig ist. Name,
// Eintritt, Austritt, fremde Zugehörigkeiten und das Löschen der Person
// bleiben über diesen Weg unerreichbar.
import { json, err, unauthorized, forbidden } from '../../../_lib/auth.js';
import { darfVerwalten } from '../../../_lib/auth.js';

async function ladePerson(env, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return { error: err('Ungültige ID') };
  const row = await env.DB.prepare(
    `SELECT id, nachname, vorname FROM personen WHERE id = ?`
  ).bind(id).first();
  if (!row) return { error: err('Person nicht gefunden', 404) };
  return { person: row };
}

function abteilungAus(wert) {
  if (wert === undefined || wert === null || wert === '') return null;
  const n = Number(wert);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

export async function onRequestPost({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const { person, error } = await ladePerson(env, params);
  if (error) return error;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const abteilungId = abteilungAus(body?.abteilung_id);
  if (abteilungId === null) return err('abteilung_id fehlt');
  if (Number.isNaN(abteilungId)) return err('abteilung_id ungültig');
  if (!(await darfVerwalten(env, data.user, abteilungId))) return forbidden();

  const rolleId = abteilungAus(body?.rolle_id);
  if (Number.isNaN(rolleId)) return err('rolle_id ungültig');

  const schonDa = await env.DB.prepare(
    `SELECT 1 AS da FROM personen_abteilungen WHERE person_id = ? AND abteilung_id = ?`
  ).bind(person.id, abteilungId).first();

  if (schonDa) {
    // Schon zugeordnet: dann nur die Rolle setzen. Ein zweiter Klick soll
    // nicht scheitern, sondern das Offensichtliche tun.
    await env.DB.prepare(
      `UPDATE personen_abteilungen SET rolle_id = ? WHERE person_id = ? AND abteilung_id = ?`
    ).bind(rolleId, person.id, abteilungId).run();
    return json({ ok: true, person_id: person.id, abteilung_id: abteilungId,
                  rolle_id: rolleId, neu: false });
  }

  await env.DB.prepare(
    `INSERT INTO personen_abteilungen (person_id, abteilung_id, rolle_id) VALUES (?, ?, ?)`
  ).bind(person.id, abteilungId, rolleId).run();

  return json({ ok: true, person_id: person.id, abteilung_id: abteilungId,
                rolle_id: rolleId, neu: true }, { status: 201 });
}

export async function onRequestDelete({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const { person, error } = await ladePerson(env, params);
  if (error) return error;

  const abteilungId = abteilungAus(new URL(request.url).searchParams.get('abteilung_id'));
  if (abteilungId === null) return err('abteilung_id fehlt');
  if (Number.isNaN(abteilungId)) return err('abteilung_id ungültig');
  if (!(await darfVerwalten(env, data.user, abteilungId))) return forbidden();

  // Eine Person ganz ohne Abteilung wäre in keiner Teilnehmerliste mehr.
  const anzahl = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM personen_abteilungen WHERE person_id = ?`
  ).bind(person.id).first();
  if ((anzahl?.c ?? 0) <= 1) {
    return err('Letzte Abteilung der Person kann hier nicht entfernt werden — '
             + 'die Person wäre dann in keiner Teilnehmerliste mehr', 409);
  }

  await env.DB.prepare(
    `DELETE FROM personen_abteilungen WHERE person_id = ? AND abteilung_id = ?`
  ).bind(person.id, abteilungId).run();

  return json({ ok: true, person_id: person.id, abteilung_id: abteilungId });
}
