// GET    /api/attendance/:id — Anwesenheit inkl. Teilnehmer + Tag-IDs
// PUT    /api/attendance/:id — Anwesenheit aktualisieren
// DELETE /api/attendance/:id — Anwesenheit löschen
//
// Zugriff hat der übergreifende Admin, der Abteilungsadmin innerhalb seiner
// Abteilungen und der Erfasser für seine eigenen Einträge.
import { json, err, unauthorized, forbidden, isAppAdmin } from '../../_lib/auth.js';
import { erlaubteAbteilungen, darfAbteilung, isAbteilungsAdmin } from '../../_lib/auth.js';
import { teilnehmerAus, teilnehmerAnweisungen } from '../attendance.js';
import { protokolliere, auditEintrag } from '../../_lib/audit.js';

// Gemeinsame Zugriffsregel für einen einzelnen Termin.
async function darfTermin(env, user, session) {
  if (isAppAdmin(user)) return true;
  if (session.created_by === user.username) return true;
  if (isAbteilungsAdmin(user)) {
    const erlaubt = await erlaubteAbteilungen(env, user);
    return darfAbteilung(erlaubt, session.abteilung_id);
  }
  return false;
}


export async function onRequestGet({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const session = await env.DB.prepare(
    `SELECT s.id, s.datum, s.zeit_von, s.zeit_bis, s.dienstart, s.thema,
            s.ausbilder, s.bemerkung, s.created_by, s.created_at,
            s.migriert_quelle, s.abteilung_id, s.florix_erfasst_at, s.florix_erfasst_by,
            a.name AS abteilung, a.kurz AS abteilung_kurz
     FROM attendance_sessions s
     LEFT JOIN abteilungen a ON a.id = s.abteilung_id
     WHERE s.id = ?`
  )
    .bind(id)
    .first();
  if (!session) return err('Nicht gefunden', 404);

  if (!(await darfTermin(env, data.user, session))) return forbidden();

  const { results: entries } = await env.DB.prepare(
    `SELECT id, nachname, vorname, status, bemerkung, migriert_quelle
     FROM attendance_entries
     WHERE session_id = ?
     ORDER BY vorname COLLATE NOCASE, nachname COLLATE NOCASE`
  )
    .bind(id)
    .all();

  const { results: tagRows } = await env.DB.prepare(
    `SELECT et.entry_id, et.tag_id
     FROM attendance_entry_tags et
     JOIN attendance_entries e ON e.id = et.entry_id
     WHERE e.session_id = ?`
  )
    .bind(id)
    .all();

  const tagsByEntry = new Map();
  for (const r of tagRows) {
    if (!tagsByEntry.has(r.entry_id)) tagsByEntry.set(r.entry_id, []);
    tagsByEntry.get(r.entry_id).push(r.tag_id);
  }
  for (const e of entries) e.tag_ids = tagsByEntry.get(e.id) || [];

  return json({ ...session, entries });
}

export async function onRequestPut({ request, env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const existing = await env.DB.prepare(
    `SELECT id, created_by, abteilung_id FROM attendance_sessions WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!existing) return err('Nicht gefunden', 404);

  if (!(await darfTermin(env, data.user, existing))) return forbidden();

  let body;
  try {
    body = await request.json();
  } catch {
    return err('Ungültiges JSON');
  }

  const datum = String(body.datum || '').trim();
  const dienstart = String(body.dienstart || '').trim();
  const thema = String(body.thema || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return err('datum fehlt oder ungültig');
  if (!dienstart) return err('dienstart fehlt');
  if (!thema) return err('thema fehlt');

  const zeit_von = String(body.zeit_von || '').trim() || null;
  const zeit_bis = String(body.zeit_bis || '').trim() || null;
  const ausbilder = String(body.ausbilder || '').trim() || null;
  const bemerkung = String(body.bemerkung || '').trim() || null;

  const { eintraege, fehler } = await teilnehmerAus(env, body);
  if (fehler) return err(fehler);

  // Die Einträge werden gleich komplett ersetzt. Vorher merken, welche
  // Teilnahme aus einer Migration stammt: sonst verliert ein beliebiger
  // Speichervorgang in der Maske die Herkunft, und die Angabe im Datensatz
  // wäre nach der ersten Bearbeitung wertlos.
  const { results: herkunftRows } = await env.DB.prepare(
    `SELECT nachname, vorname, migriert_quelle FROM attendance_entries
     WHERE session_id = ? AND migriert_quelle IS NOT NULL`
  )
    .bind(id)
    .all();
  const herkunft = new Map(
    herkunftRows.map((r) => [`${r.nachname.toLowerCase()}|${r.vorname.toLowerCase()}`, r.migriert_quelle])
  );

  // Kopf ändern, Einträge (inkl. Tag-Zuordnungen über CASCADE) löschen und
  // neu schreiben: alles in einem Batch. Vorher in getrennten Schritten; ein
  // Abbruch nach dem Löschen hinterließ einen leeren Termin (Befund S1).
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE attendance_sessions
       SET datum = ?, zeit_von = ?, zeit_bis = ?, dienstart = ?, thema = ?,
           ausbilder = ?, bemerkung = ?
       WHERE id = ?`
    ).bind(datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung, id),
    env.DB.prepare(`DELETE FROM attendance_entries WHERE session_id = ?`).bind(id),
    ...teilnehmerAnweisungen(env, '?', [id], eintraege, herkunft),
  ]);

  return json({ id });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  // Löschen darf der übergreifende Admin und der Abteilungsadmin in seinen
  // Abteilungen. Ein Erfasser nicht — auch nicht bei eigenen Einträgen, das
  // war schon vorher so und bleibt.
  const vorhanden = await env.DB.prepare(
    `SELECT id, created_by, abteilung_id FROM attendance_sessions WHERE id = ?`
  ).bind(id).first();
  if (!vorhanden) return err('Nicht gefunden', 404);

  const darf = isAppAdmin(data.user)
    || (isAbteilungsAdmin(data.user)
        && darfAbteilung(await erlaubteAbteilungen(env, data.user), vorhanden.abteilung_id));
  if (!darf) return forbidden();

  const res = await env.DB.prepare(`DELETE FROM attendance_sessions WHERE id = ?`)
    .bind(id)
    .run();
  if (!res.success) return err('Löschen fehlgeschlagen', 500);
  await protokolliere(env, data.user, { bereich: 'anwesenheit', aktion: 'loeschen', objekt: 'termin', objektId: id,
    details: { abteilung_id: vorhanden.abteilung_id, erfasst_von: vorhanden.created_by } });
  return json({ ok: true });
}
