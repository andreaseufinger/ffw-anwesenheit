// PUT    /api/personen/:id — Person ändern (Admin)
// DELETE /api/personen/:id — Person entfernen (Admin), nur ohne Historie
//
// Löschen ist absichtlich eng: sobald eine Person in einem Ausbildungsabend
// oder Einsatz auftaucht, würde das Entfernen sie aus den Auswertungen
// vergangener Jahre tilgen, während die Protokolleinträge selbst bestehen
// bleiben. In diesem Fall ist aktiv = 0 der richtige Weg — die Person
// verschwindet aus den Auswahllisten und bleibt in der Statistik.
import { json, err, unauthorized, forbidden, isAppAdmin } from '../../_lib/auth.js';
import { validatePerson, normalisiereZuordnungen } from '../personen.js';
import { PERSONENBEZUG, bezuegeZaehlen, bezuegeText } from '../../_lib/personenbezug.js';
import { erlaubteAbteilungen, darfAbteilung, darfVerwalten,
         darfIrgendwasVerwalten } from '../../_lib/auth.js';
import { protokolliere, auditEintrag } from '../../_lib/audit.js';

function requireVerwalter(data) {
  if (!data.user) return unauthorized();
  if (!darfIrgendwasVerwalten(data.user)) return forbidden();
  return null;
}

// Eine Person darf verwalten, wer für MINDESTENS EINE ihrer Abteilungen
// zuständig ist. Der übergreifende Admin immer.
async function darfPerson(env, user, personId) {
  if (isAppAdmin(user)) return true;
  const erlaubt = await erlaubteAbteilungen(env, user);
  if (erlaubt === null) return true;
  if (!erlaubt.length) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS treffer FROM personen_abteilungen
     WHERE person_id = ? AND abteilung_id IN (${erlaubt.map(() => '?').join(', ')})
     LIMIT 1`
  ).bind(personId, ...erlaubt).first();
  return !!row;
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

// Historie über die person_id in allen Tabellen mit Personenbezug. Früher
// wurde über den Namen in drei Tabellen gesucht: Wer umbenannt war oder nur
// Atemschutz- oder Kleidungsdaten hatte, ließ sich löschen, und diese Daten
// verschwanden per CASCADE (Review-Befund D1).
async function historieZaehlen(env, personId) {
  const zahlen = await bezuegeZaehlen(env, personId);
  const gesamt = PERSONENBEZUG.filter((b) => b.historie).reduce((s, b) => s + zahlen[b.tabelle], 0);
  return {
    abende: zahlen.attendance_entries,
    besatzung: zahlen.einsatz_besatzung,
    pa: zahlen.einsatz_pa,
    gesamt,
    beschreibung: bezuegeText(zahlen, { nurHistorie: true }),
  };
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireVerwalter(data); if (denied) return denied;
  const { person, error: notFound } = await loadPerson(env, params);
  if (notFound) return notFound;

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  const { value, error } = validatePerson(body);
  if (error) return err(error);

  if (!(await darfPerson(env, data.user, person.id))) return forbidden();

  const kollision = await env.DB.prepare(
    `SELECT id FROM personen
     WHERE nachname = ? COLLATE NOCASE AND vorname = ? COLLATE NOCASE AND id != ?`
  ).bind(value.nachname, value.vorname, person.id).first();
  if (kollision) return err('Eine andere Person trägt diesen Namen bereits', 409);

  // Abteilungs-Zuordnungen nur innerhalb der eigenen Zuständigkeit ersetzen.
  // Ein Jugendwart darf dem Jugendwart-Kollegen nicht die Einsatzabteilung
  // entziehen — fremde Zuordnungen bleiben unangetastet. Dasselbe Muster wie
  // bei den App-Rollen in users/[id].js.
  if (Array.isArray(body?.abteilungen) || Array.isArray(body?.abteilung_ids)) {
    const gewuenscht = normalisiereZuordnungen(body);
    const erlaubt = await erlaubteAbteilungen(env, data.user);
    for (const z of gewuenscht) {
      if (!(await darfVerwalten(env, data.user, z.abteilung_id))) return forbidden();
    }
    if (erlaubt === null) {
      if (!gewuenscht.length) return err('Mindestens eine Abteilung erforderlich');
      await env.DB.prepare(`DELETE FROM personen_abteilungen WHERE person_id = ?`)
        .bind(person.id).run();
    } else if (erlaubt.length) {
      await env.DB.prepare(
        `DELETE FROM personen_abteilungen
         WHERE person_id = ? AND abteilung_id IN (${erlaubt.map(() => '?').join(', ')})`
      ).bind(person.id, ...erlaubt).run();
    }
    if (gewuenscht.length) {
      const stmt = env.DB.prepare(
        `INSERT OR IGNORE INTO personen_abteilungen (person_id, abteilung_id, rolle_id)
         VALUES (?, ?, ?)`
      );
      await env.DB.batch(gewuenscht.map((z) => stmt.bind(person.id, z.abteilung_id, z.rolle_id)));
    }
    // Ganz ohne Zuordnung wäre die Person in keiner Teilnehmerliste.
    const rest = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM personen_abteilungen WHERE person_id = ?`
    ).bind(person.id).first();
    if ((rest?.c ?? 0) === 0) {
      return err('Person hätte danach keine Abteilung mehr', 400);
    }
  }

  await env.DB.prepare(
    `UPDATE personen SET nachname = ?, vorname = ?, aktiv = ?, eintritt = ?, austritt = ?
     WHERE id = ?`
  ).bind(value.nachname, value.vorname, value.aktiv, value.eintritt, value.austritt, person.id).run();

  await protokolliere(env, data.user, { bereich: 'personen', aktion: 'aendern', objekt: 'person', objektId: person.id,
    details: { vorher: `${person.nachname}, ${person.vorname}`, nachher: `${value.nachname}, ${value.vorname}`, aktiv: value.aktiv } });
  return json({ id: person.id, ...value });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireVerwalter(data); if (denied) return denied;
  const { person, error } = await loadPerson(env, params);
  if (error) return error;

  if (!(await darfPerson(env, data.user, person.id))) return forbidden();

  const h = await historieZaehlen(env, person.id);
  if (h.gesamt > 0) {
    return json({
      error: 'Person hat Historie und kann nicht gelöscht werden — '
           + 'stattdessen auf „nicht aktiv" setzen',
      historie: h,
    }, { status: 409 });
  }

  await env.DB.prepare(`DELETE FROM personen WHERE id = ?`).bind(person.id).run();
  await protokolliere(env, data.user, { bereich: 'personen', aktion: 'loeschen', objekt: 'person', objektId: person.id,
    details: { name: `${person.nachname}, ${person.vorname}` } });
  return json({ ok: true, id: person.id });
}
