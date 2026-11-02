// GET  /api/attendance  — Liste (Admin)
// POST /api/attendance  — neue Anwesenheit speichern (Admin + Erfasser)
import { json, err, unauthorized, forbidden, isAppAdmin } from '../_lib/auth.js';
import { erlaubteAbteilungen, darfAbteilung, abteilungsFilter,
         isAbteilungsAdmin } from '../_lib/auth.js';

const STATUS = new Set(['anwesend', 'entschuldigt', 'abwesend', '']);

// Teilnehmerliste aus dem Body prüfen. Gemeinsam für POST und PUT.
// Gibt { eintraege } oder { fehler } zurück; unbekannte Zusatzinfos sind ein
// Fehler, weil sie sonst mitten im Speichern am Fremdschlüssel scheitern.
export async function teilnehmerAus(env, body) {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return { fehler: 'Keine Teilnehmer übergeben' };
  const eintraege = [];
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
    eintraege.push({ nachname, vorname, status, bemerkung: bem, tag_ids: tagIds });
  }
  if (!eintraege.length) return { fehler: 'Keine gültigen Teilnehmer' };
  const genutzt = [...new Set(eintraege.flatMap((e) => e.tag_ids))];
  if (genutzt.length) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM tags WHERE id IN (${genutzt.map(() => '?').join(', ')})`
    ).bind(...genutzt).all();
    const da = new Set(results.map((r) => r.id));
    const fehlt = genutzt.filter((t) => !da.has(t));
    if (fehlt.length) return { fehler: `Unbekannte Zusatzinfo: ${fehlt.join(', ')}` };
  }
  return { eintraege };
}

// Anweisungen für Teilnehmer und Zusatzinfos, zum Einfügen in denselben
// Batch wie der Termin (ein Batch = eine Transaktion). sessionIdSql ist ein
// SQL-Ausdruck: beim Anlegen "(SELECT MAX(id) FROM attendance_sessions)", weil
// die ID erst im Batch entsteht. Die Zusatzinfos hängen an
// "(SELECT MAX(id) FROM attendance_entries)", dem gerade eingefügten Eintrag;
// D1 führt einen Batch ohne fremde Schreibzugriffe dazwischen aus.
export function teilnehmerAnweisungen(env, sessionIdSql, sessionBinds, eintraege, herkunft = new Map()) {
  const eintrag = env.DB.prepare(
    `INSERT INTO attendance_entries
       (session_id, nachname, vorname, status, bemerkung, person_id, migriert_quelle)
       -- person_id wird beim Schreiben direkt mit aufgelöst. Ohne das hätten
       -- neue Einträge keine Verknüpfung und die Auswertung würde mit der
       -- Zeit wieder auf Namensvergleiche zurückfallen.
     VALUES (${sessionIdSql}, ?, ?, ?, ?, (SELECT p.id FROM personen p WHERE p.nachname = ? COLLATE NOCASE AND p.vorname = ? COLLATE NOCASE), ?)`
  );
  const tags = env.DB.prepare(
    `INSERT INTO attendance_entry_tags (entry_id, tag_id)
     SELECT (SELECT MAX(id) FROM attendance_entries), value FROM json_each(?)`
  );
  const out = [];
  for (const e of eintraege) {
    out.push(eintrag.bind(...sessionBinds, e.nachname, e.vorname, e.status, e.bemerkung, e.nachname, e.vorname,
      herkunft.get(`${e.nachname.toLowerCase()}|${e.vorname.toLowerCase()}`) ?? null));
    if (e.tag_ids.length) out.push(tags.bind(JSON.stringify(e.tag_ids)));
  }
  return out;
}

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

  const { eintraege, fehler } = await teilnehmerAus(env, body);
  if (fehler) return err(fehler);

  // Termin, Teilnehmer und Zusatzinfos in einem Batch: alles oder nichts.
  // Vorher in drei Schritten; ein Abbruch hinterließ einen Termin ohne
  // Teilnehmer oder ohne Zusatzinfos (Review-Befund S1).
  const ergebnis = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attendance_sessions
         (datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung,
          created_by, abteilung_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(datum, zeit_von, zeit_bis, dienstart, thema, ausbilder, bemerkung,
           data.user.username, abteilungId),
    ...teilnehmerAnweisungen(env, '(SELECT MAX(id) FROM attendance_sessions)', [], eintraege),
  ]);

  return json({ id: ergebnis[0].meta.last_row_id }, { status: 201 });
}
