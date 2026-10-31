// GET /api/kleidung — Übersicht Kleidung: alle geführten Teile im Bestand mit
// letzter Reinigung, Fälligkeit und Status, dazu Artikelarten und ZMS-Stand.
import { json, unauthorized, forbidden, darfKleidung } from '../_lib/auth.js';
import { istFehlendeTabelle } from '../_lib/stammdaten.js';
import { teilStatus, faelligAm } from '../_lib/kleidung.js';
import { heuteBerlin } from '../_lib/agt.js';

// Teile mit letzter Reinigung und offener Abgabe. Gemeinsam für Liste,
// Einzelabruf und die Kleidungsspalte der AGT-Übersicht.
export const TEILE_SQL = `
  SELECT t.id, t.identifikation, t.barcode, t.typ, t.groesse, t.person_id, t.standort,
         t.quelle, t.im_bestand, t.artikelart_id,
         a.name AS artikelart, a.intervall_monate, a.agt_relevant,
         p.nachname, p.vorname, p.agt,
         (SELECT MAX(r.gereinigt_am) FROM kleidung_reinigungen r WHERE r.teil_id = t.id) AS letzte_reinigung,
         (SELECT MIN(COALESCE(r.abgegeben_am, '')) FROM kleidung_reinigungen r
            WHERE r.teil_id = t.id AND r.gereinigt_am IS NULL) AS in_reinigung_seit
  FROM kleidung_teile t
  LEFT JOIN kleidung_artikelarten a ON a.id = t.artikelart_id
  LEFT JOIN personen p ON p.id = t.person_id`;

export function teilAufbereiten(t, heute) {
  return {
    ...t,
    person: t.person_id ? `${t.nachname}, ${t.vorname}` : null,
    agt: !!t.agt,
    faellig_am: faelligAm(t.letzte_reinigung, t.intervall_monate),
    status: teilStatus(t, heute),
  };
}

export async function mitKleidung(fn) {
  try {
    return await fn();
  } catch (e) {
    if (istFehlendeTabelle(e)) {
      return json({
        error: 'Die Tabellen des Moduls Kleidung fehlen — die Migration '
             + '2026-10-27_kleidung.sql wurde noch nicht ausgeführt.',
        migration_fehlt: true,
      }, { status: 503 });
    }
    throw e;
  }
}

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();

  return mitKleidung(async () => {
    const [teile, arten, stand] = await Promise.all([
      env.DB.prepare(`${TEILE_SQL}
        WHERE t.im_bestand = 1 AND t.artikelart_id IS NOT NULL
        ORDER BY p.nachname COLLATE NOCASE, p.vorname COLLATE NOCASE, a.sort_order, t.barcode`).all(),
      env.DB.prepare(
        `SELECT id, name, intervall_monate, agt_relevant, sort_order FROM kleidung_artikelarten
         ORDER BY sort_order, name`
      ).all(),
      env.DB.prepare(
        `SELECT importiert_at, importiert_by, uebernommen FROM kleidung_importe ORDER BY id DESC LIMIT 1`
      ).first(),
    ]);
    const heute = heuteBerlin();
    return json({
      heute,
      artikelarten: arten.results,
      zms_stand: stand || null,
      teile: teile.results.map((t) => teilAufbereiten(t, heute)),
    });
  });
}
