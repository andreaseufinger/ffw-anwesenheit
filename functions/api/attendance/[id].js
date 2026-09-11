// GET    /api/attendance/:id — Anwesenheit inkl. Teilnehmer + Tag-IDs (Admin)
// PUT    /api/attendance/:id — Anwesenheit aktualisieren (Admin oder eigene)
// DELETE /api/attendance/:id — Anwesenheit löschen (Admin)
import { json, err, unauthorized, forbidden, isAppAdmin } from '../../_lib/auth.js';

const STATUS = new Set(['anwesend', 'entschuldigt', 'abwesend', '']);

function requireAdmin(data) {
  if (!data.user) return unauthorized();
  if (!isAppAdmin(data.user)) return forbidden();
  return null;
}

export async function onRequestGet({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const session = await env.DB.prepare(
    `SELECT id, datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung, created_by, created_at
     FROM attendance_sessions WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!session) return err('Nicht gefunden', 404);

  if (!isAppAdmin(data.user) && session.created_by !== data.user.username) {
    return forbidden();
  }

  const { results: entries } = await env.DB.prepare(
    `SELECT id, nachname, vorname, status, bemerkung
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
    `SELECT id, created_by FROM attendance_sessions WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!existing) return err('Nicht gefunden', 404);

  if (!isAppAdmin(data.user) && existing.created_by !== data.user.username) {
    return forbidden();
  }

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

  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return err('Keine Teilnehmer übergeben');

  const cleanEntries = [];
  for (const e of entries) {
    const nachname = String(e.nachname || '').trim();
    const vorname = String(e.vorname || '').trim();
    const status = String(e.status || '').trim();
    const bem = String(e.bemerkung || '').trim() || null;
    const tagIds = Array.isArray(e.tag_ids)
      ? [...new Set(e.tag_ids.map((x) => Number(x)).filter(Number.isFinite))]
      : [];
    if (!nachname || !vorname) continue;
    if (!STATUS.has(status)) continue;
    cleanEntries.push({ nachname, vorname, status, bemerkung: bem, tag_ids: tagIds });
  }
  if (!cleanEntries.length) return err('Keine gültigen Teilnehmer');

  await env.DB.prepare(
    `UPDATE attendance_sessions
     SET datum = ?, zeit_von = ?, zeit_bis = ?, dienstart = ?, thema = ?,
         ausbilder = ?, bemerkung = ?
     WHERE id = ?`
  )
    .bind(datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung, id)
    .run();

  // Einträge (inkl. Tag-Zuordnungen über CASCADE) komplett ersetzen
  await env.DB.prepare(`DELETE FROM attendance_entries WHERE session_id = ?`).bind(id).run();

  const entryStmt = env.DB.prepare(
    `INSERT INTO attendance_entries
       (session_id, nachname, vorname, status, bemerkung)
     VALUES (?, ?, ?, ?, ?)`
  );
  const entryResults = await env.DB.batch(
    cleanEntries.map((e) => entryStmt.bind(id, e.nachname, e.vorname, e.status, e.bemerkung))
  );
  const entryIds = entryResults.map((r) => r.meta.last_row_id);

  const tagStmt = env.DB.prepare(
    `INSERT INTO attendance_entry_tags (entry_id, tag_id) VALUES (?, ?)`
  );
  const tagBatch = [];
  cleanEntries.forEach((e, i) => {
    for (const tagId of e.tag_ids) tagBatch.push(tagStmt.bind(entryIds[i], tagId));
  });
  if (tagBatch.length) await env.DB.batch(tagBatch);

  return json({ id });
}

export async function onRequestDelete({ env, params, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  const denied = requireAdmin(data);
  if (denied) return denied;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return err('Ungültige ID');

  const res = await env.DB.prepare(`DELETE FROM attendance_sessions WHERE id = ?`)
    .bind(id)
    .run();
  if (!res.success) return err('Löschen fehlgeschlagen', 500);
  return json({ ok: true });
}
