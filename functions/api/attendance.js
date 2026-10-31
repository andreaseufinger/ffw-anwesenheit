// GET  /api/attendance  — Liste (Admin)
// POST /api/attendance  — neue Anwesenheit speichern (Admin + Erfasser)
import { json, err, unauthorized, forbidden, isAppAdmin } from '../_lib/auth.js';
import { erlaubteAbteilungen, darfAbteilung, abteilungsFilter,
         isAbteilungsAdmin } from '../_lib/auth.js';

const STATUS = new Set(['anwesend', 'entschuldigt', 'abwesend', '']);

export async function onRequestGet({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  const isAdmin = isAppAdmin(data.user);
  // Optionaler Filter ?abteilung_id= für den Verlauf. Er schränkt nur ein,
  // die Sichtbarkeit unten gilt trotzdem.
  const abtParam = new URL(request.url).searchParams.get('abteilung_id');
  const abtId = abtParam ? Number(abtParam) : null;
  if (abtParam && !Number.isInteger(abtId)) return err('abteilung_id ungültig');
  const abtKlausel = abtId !== null ? ' AND s.abteilung_id = ? ' : '';
  const abtBinds = abtId !== null ? [abtId] : [];
  const baseQuery = `
    SELECT
       s.id, s.datum, s.zeit_von, s.zeit_bis, s.dienstart, s.thema,
       s.ausbilder, s.bemerkung, s.created_by, s.created_at, s.migriert_quelle,
       s.florix_erfasst_at, s.florix_erfasst_by,
       s.abteilung_id, a.name AS abteilung, a.kurz AS abteilung_kurz,
       (SELECT COUNT(*) FROM attendance_entries e
          WHERE e.session_id = s.id AND e.status = 'anwesend') AS anwesend_count,
       -- Mitglieder der Abteilung an diesem Tag, Nenner für den Beteiligungsbalken
       -- im Verlauf. Nur Anwesende werden gespeichert, deshalb aus den Stammdaten.
       (SELECT COUNT(*) FROM personen_abteilungen pa JOIN personen p ON p.id = pa.person_id
          WHERE pa.abteilung_id = s.abteilung_id
            AND (pa.von IS NULL OR pa.von <= s.datum) AND (pa.bis IS NULL OR pa.bis >= s.datum)
            AND (p.eintritt IS NULL OR p.eintritt <= s.datum)
            AND CASE WHEN p.austritt IS NOT NULL THEN p.austritt >= s.datum ELSE p.aktiv = 1 END
       ) AS mitglieder_count
     FROM attendance_sessions s
     LEFT JOIN abteilungen a ON a.id = s.abteilung_id`;

  // Drei Sichtbarkeiten:
  //   übergreifender Admin  -> alles
  //   Abteilungsadmin       -> alles in seinen Abteilungen
  //   Erfasser              -> nur eigene Einträge (unverändert)
  if (isAdmin) {
    const { results } = await env.DB.prepare(
      baseQuery + ` WHERE 1 = 1 ${abtKlausel} ORDER BY s.datum DESC, s.id DESC LIMIT 500`
    ).bind(...abtBinds).all();
    return json(results);
  }

  if (isAbteilungsAdmin(data.user)) {
    const erlaubt = await erlaubteAbteilungen(env, data.user);
    const f = abteilungsFilter(erlaubt, 's.abteilung_id');
    const { results } = await env.DB.prepare(
      baseQuery + ` WHERE 1 = 1 ${f.klausel} ${abtKlausel} ORDER BY s.datum DESC, s.id DESC LIMIT 500`
    ).bind(...f.binds, ...abtBinds).all();
    return json(results);
  }

  const { results } = await env.DB.prepare(
    baseQuery + ` WHERE s.created_by = ? ${abtKlausel} ORDER BY s.datum DESC, s.id DESC LIMIT 500`
  ).bind(data.user.username, ...abtBinds).all();
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

  // Abteilung ist Pflicht, sobald es mehr als eine gibt. Ohne Angabe wird die
  // einzige erlaubte genommen — so bleibt ein Ein-Abteilungs-Betrieb
  // unverändert bedienbar.
  const erlaubt = await erlaubteAbteilungen(env, data.user);
  let abteilungId = null;
  if (body.abteilung_id !== undefined && body.abteilung_id !== null && body.abteilung_id !== '') {
    const n = Number(body.abteilung_id);
    if (!Number.isFinite(n)) return err('abteilung_id ungültig');
    abteilungId = Math.trunc(n);
  }
  if (abteilungId === null) {
    if (erlaubt !== null && erlaubt.length === 1) {
      abteilungId = erlaubt[0];
    } else {
      const einzige = await env.DB.prepare(
        `SELECT id FROM abteilungen ORDER BY sort_order, id LIMIT 2`
      ).all();
      if ((einzige.results || []).length === 1) abteilungId = einzige.results[0].id;
    }
  }
  if (abteilungId === null) return err('abteilung_id fehlt');
  if (!darfAbteilung(erlaubt, abteilungId)) {
    return forbidden();
  }

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
       (datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung,
        created_by, abteilung_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung,
          data.user.username, abteilungId)
    .run();
  const sessionId = sessionRes.meta.last_row_id;

  const entryStmt = env.DB.prepare(
    `INSERT INTO attendance_entries
       (session_id, nachname, vorname, status, bemerkung, person_id)
       -- person_id wird beim Schreiben direkt mit aufgelöst. Ohne das hätten
       -- neue Einträge keine Verknüpfung und die Auswertung würde mit der
       -- Zeit wieder auf Namensvergleiche zurückfallen.
     VALUES (?, ?, ?, ?, ?, (SELECT p.id FROM personen p WHERE p.nachname = ? COLLATE NOCASE AND p.vorname = ? COLLATE NOCASE))`
  );
  const entryResults = await env.DB.batch(
    cleanEntries.map((e) =>
      entryStmt.bind(sessionId, e.nachname, e.vorname, e.status, e.bemerkung,
                     e.nachname, e.vorname)
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
