// GET  /api/einsaetze — Liste (Admin: alle, Erfasser: eigene + alle offenen)
// POST /api/einsaetze — neuen Einsatz speichern (alle eingeloggten Benutzer)
import { json, err, unauthorized, forbidden, isEpReaderAll, isEpWriter } from '../_lib/auth.js';

export async function onRequestGet({ env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();

  // Admin und Leser sehen ALLE Einsätze; Erfasser nur eigene + alle offenen.
  const canSeeAll = isEpReaderAll(data.user);
  const baseQuery = `
    SELECT
       e.id, e.alarm_datum, e.alarm_uhrzeit, e.einsatzort, e.einsatzgrund,
       e.einsatzleiter, e.km_einsatzstelle, e.km_gesamt, e.notizen,
       e.alarmierte_einheit,
       e.status, e.abgeschlossen_at, e.abgeschlossen_by,
       e.created_by, e.created_at, e.updated_at, e.migriert_quelle,
       (SELECT GROUP_CONCAT(s.kennung, ', ')
          FROM einsatz_fahrzeuge ef
          JOIN einsatz_fahrzeuge_stamm s ON s.id = ef.fahrzeug_id
          WHERE ef.einsatz_id = e.id) AS fahrzeuge_kennungen
     FROM einsaetze e`;

  // Erfasser sieht: eigene Einsätze + alle offenen (damit sie an einem
  // laufenden, von Kollegen erfassten Einsatz mitwirken können).
  const { results } = canSeeAll
    ? await env.DB.prepare(baseQuery + ` ORDER BY e.alarm_datum DESC, e.alarm_uhrzeit DESC, e.id DESC LIMIT 500`).all()
    : await env.DB.prepare(baseQuery + ` WHERE e.created_by = ? OR e.status = 'offen' ORDER BY e.alarm_datum DESC, e.alarm_uhrzeit DESC, e.id DESC LIMIT 500`)
        .bind(data.user.username).all();

  return json(results);
}

export async function onRequestPost({ request, env, data }) {
  if (!env.DB) return err('D1 not bound', 500);
  if (!data.user) return unauthorized();
  if (!isEpWriter(data.user)) return forbidden();

  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body?.alarm_datum || ''))) return err('alarm_datum ungültig');
  if (!/^\d{2}:\d{2}$/.test(String(body?.alarm_uhrzeit || ''))) return err('alarm_uhrzeit ungültig');

  const ergebnis = await anlegeEinsatz(env, body, data.user.username);
  if (ergebnis.fehler) return err(ergebnis.fehler);
  return json({ id: ergebnis.id }, { status: 201 });
}

// =====================================================================
// Legt einen Einsatz mit allen abhängigen Datensätzen an, in EINEM Batch
// (eine Transaktion): Einsatz, FFen vor Ort, Fahrzeuge mit Besatzung, PA,
// Verunfallte. Vorher in vielen Einzelschritten; ein Fehler mittendrin
// hinterließ einen Einsatz ohne Fahrzeuge oder PA-Liste (Review-Befund S1).
//
// Die IDs entstehen erst im Batch. Abhängige Zeilen verweisen deshalb auf
// "(SELECT MAX(id) FROM …)", den gerade eingefügten Datensatz; D1 führt einen
// Batch ohne fremde Schreibzugriffe dazwischen aus.
//
// Granulare Änderungen während eines laufenden Einsatzes laufen über die
// Endpunkte in functions/api/einsaetze/[id]/*.js. Den früheren Komplett-
// Ersatz per PUT /api/einsaetze/:id gibt es nicht mehr (Befund S4).
// =====================================================================
const NEUER_EINSATZ = '(SELECT MAX(id) FROM einsaetze)';
const NEUES_FAHRZEUG = '(SELECT MAX(id) FROM einsatz_fahrzeuge)';

export async function anlegeEinsatz(env, body, username) {
  const alarm_datum   = String(body.alarm_datum).trim();
  const alarm_uhrzeit = String(body.alarm_uhrzeit).trim();
  const einsatzort    = strOrNull(body.einsatzort);
  const einsatzgrund  = strOrNull(body.einsatzgrund);
  const einsatzleiter = strOrNull(body.einsatzleiter);
  const km_es         = numOrNull(body.km_einsatzstelle);
  const km_total      = numOrNull(body.km_gesamt);
  const erste_ff_id   = Number.isFinite(body.erste_ff_id) ? Math.trunc(body.erste_ff_id) : null;
  const notizen       = strOrNull(body.notizen);
  const alarmierte_einheit = strOrNull(body.alarmierte_einheit);

  const ffIds = Array.isArray(body.ff_ids)
    ? [...new Set(body.ff_ids.map((x) => Number(x)).filter(Number.isFinite))]
    : [];
  const fahrzeuge = [];
  const gesehen = new Set();
  for (const f of Array.isArray(body.fahrzeuge) ? body.fahrzeuge : []) {
    const fahrzeugId = Number(f?.fahrzeug_id);
    if (!Number.isFinite(fahrzeugId) || gesehen.has(fahrzeugId)) continue;
    gesehen.add(fahrzeugId);
    fahrzeuge.push({ ...f, fahrzeug_id: fahrzeugId });
  }

  // Verweise vorher prüfen: eine unbekannte ID ist ein Eingabefehler (400),
  // kein Serverfehler mitten im Speichern.
  const fehlt = async (tabelle, ids) => {
    if (!ids.length) return [];
    const { results } = await env.DB.prepare(
      `SELECT id FROM ${tabelle} WHERE id IN (${ids.map(() => '?').join(', ')})`
    ).bind(...ids).all();
    const da = new Set(results.map((r) => r.id));
    return ids.filter((i) => !da.has(i));
  };
  const fzFehlt = await fehlt('einsatz_fahrzeuge_stamm', fahrzeuge.map((f) => f.fahrzeug_id));
  if (fzFehlt.length) return { fehler: `Unbekanntes Fahrzeug: ${fzFehlt.join(', ')}` };
  const ffFehlt = await fehlt('einsatz_ffen_stamm', [...ffIds, ...(erste_ff_id !== null ? [erste_ff_id] : [])]);
  if (ffFehlt.length) return { fehler: `Unbekannte Feuerwehr: ${ffFehlt.join(', ')}` };

  const PERSON = `(SELECT p.id FROM personen p WHERE p.nachname = ? COLLATE NOCASE AND p.vorname = ? COLLATE NOCASE)`;
  const schritte = [env.DB.prepare(
    `INSERT INTO einsaetze
       (alarm_datum, alarm_uhrzeit, einsatzort, einsatzgrund, einsatzleiter,
        km_einsatzstelle, km_gesamt, erste_ff_id, notizen, alarmierte_einheit,
        status, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offen', ?, CURRENT_TIMESTAMP)`
  ).bind(alarm_datum, alarm_uhrzeit, einsatzort, einsatzgrund, einsatzleiter,
         km_es, km_total, erste_ff_id, notizen, alarmierte_einheit, username)];

  const ffStmt = env.DB.prepare(`INSERT INTO einsatz_ffen_vor_ort (einsatz_id, ff_id) VALUES (${NEUER_EINSATZ}, ?)`);
  schritte.push(...ffIds.map((fid) => ffStmt.bind(fid)));

  const efStmt = env.DB.prepare(
    `INSERT INTO einsatz_fahrzeuge (einsatz_id, fahrzeug_id, ende_datum, ende_uhrzeit)
     VALUES (${NEUER_EINSATZ}, ?, ?, ?)`
  );
  const bStmt = env.DB.prepare(
    `INSERT INTO einsatz_besatzung
       (einsatz_fahrzeug_id, position, person_nachname, person_vorname, person_id)
     VALUES (${NEUES_FAHRZEUG}, ?, ?, ?, ${PERSON})`
  );
  for (const f of fahrzeuge) {
    schritte.push(efStmt.bind(f.fahrzeug_id, strOrNull(f.ende_datum), strOrNull(f.ende_uhrzeit)));
    for (const b of Array.isArray(f.besatzung) ? f.besatzung : []) {
      const position = String(b?.position || '').trim();
      const pn = strOrNull(b?.person_nachname);
      const pv = strOrNull(b?.person_vorname);
      if (!position || (!pn && !pv)) continue;
      schritte.push(bStmt.bind(position, pn, pv, pn, pv));
    }
  }

  const paStmt = env.DB.prepare(
    `INSERT INTO einsatz_pa (einsatz_id, person_nachname, person_vorname, dauer_minuten, sort_order, person_id)
     VALUES (${NEUER_EINSATZ}, ?, ?, ?, ?, ${PERSON})`
  );
  (Array.isArray(body.pa) ? body.pa : []).forEach((p, i) => {
    const pn = strOrNull(p?.person_nachname);
    const pv = strOrNull(p?.person_vorname);
    if (!pn && !pv) return;
    schritte.push(paStmt.bind(pn || '', pv || '', numOrNull(p.dauer_minuten), i, pn, pv));
  });

  const vStmt = env.DB.prepare(
    `INSERT INTO einsatz_verunfallte (einsatz_id, kennzeichen, sort_order) VALUES (${NEUER_EINSATZ}, ?, ?)`
  );
  (Array.isArray(body.verunfallte) ? body.verunfallte : []).forEach((v, i) => {
    const kz = strOrNull(typeof v === 'string' ? v : v?.kennzeichen);
    if (kz) schritte.push(vStmt.bind(kz, i));
  });

  const ergebnis = await env.DB.batch(schritte);
  return { id: ergebnis[0].meta.last_row_id };
}

// =====================================================================
// Helper für granulare Endpunkte: prüft Existenz + Status (editierbar?).
// Bumpt updated_at, damit Polling-Clients die Änderung sehen.
// =====================================================================
export async function loadEditableEinsatz(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, status FROM einsaetze WHERE id = ?`
  ).bind(id).first();
  if (!row) return { error: err('Nicht gefunden', 404) };
  if (row.status !== 'offen') {
    return { error: err('Einsatzprotokoll ist abgeschlossen', 409) };
  }
  return { row };
}

// Bumpt updated_at und gibt den neuen Wert zurück, damit der schreibende Client
// ihn übernehmen kann (sonst hält ihn das Polling für eine Fremd-Änderung und
// lädt neu → Comboboxen klappen mitten in der Bearbeitung zu).
export async function touchEinsatz(env, id) {
  const row = await env.DB.prepare(
    `UPDATE einsaetze SET updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING updated_at`
  ).bind(id).first();
  return row?.updated_at ?? null;
}

export function strOrNull(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
