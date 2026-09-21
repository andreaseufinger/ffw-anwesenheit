// GET  /api/attendance  — Liste (Admin)
// POST /api/attendance  — neue Anwesenheit speichern (Admin + Erfasser)
import { json, err, unauthorized, isAppAdmin } from '../_lib/auth.js';

const STATUS = new Set(['anwesend', 'entschuldigt', 'abwesend', '']);

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const isAdmin = isAppAdmin(data.user);
  const baseQuery = `
    SELECT
       s.id, s.datum, s.zeit_von, s.zeit_bis, s.dienstart, s.thema,
       s.ausbilder, s.bemerkung, s.created_by, s.created_at,
       (SELECT COUNT(*) FROM attendance_entries e
          WHERE e.session_id = s.id AND e.status = 'anwesend') AS anwesend_count
     FROM attendance_sessions s`;

  const { results } = isAdmin
    ? await env.DB.prepare(baseQuery + ` ORDER BY s.datum DESC, s.id DESC LIMIT 500`).all()
    : await env.DB.prepare(baseQuery + ` WHERE s.created_by = ? ORDER BY s.datum DESC, s.id DESC LIMIT 500`)
        .bind(data.user.username)
        .all();

  return json(results);
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

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

  const sessionRes = await env.DB.prepare(
    `INSERT INTO attendance_sessions
       (datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung, data.user.username)
    .run();
  const sessionId = sessionRes.meta.last_row_id;

  const entryStmt = env.DB.prepare(
    `INSERT INTO attendance_entries
       (session_id, nachname, vorname, status, bemerkung)
     VALUES (?, ?, ?, ?, ?)`
  );
  const entryResults = await env.DB.batch(
    cleanEntries.map((e) =>
      entryStmt.bind(sessionId, e.nachname, e.vorname, e.status, e.bemerkung)
    )
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

  return json({ id: sessionId }, { status: 201 });
}
