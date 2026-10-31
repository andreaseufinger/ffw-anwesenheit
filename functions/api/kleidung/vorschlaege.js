// GET  /api/kleidung/vorschlaege — Einsätze der letzten 60 Tage mit
//      PA-Trägern: deren Kleidung (Arten, die für AGT zählen) sollte nach
//      dem Einsatz zur Reinigung. Erledigte Vorschläge und Teile, die nach dem
//      Einsatz schon abgegeben wurden, fallen heraus.
// POST /api/kleidung/vorschlaege — { einsatz_id, aktion: 'uebernehmen' | 'ignorieren', datum? }
//      uebernehmen: alle vorgeschlagenen Teile zur Reinigung geben.
import { json, err, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { heuteBerlin } from '../../_lib/agt.js';
import { mitKleidung } from '../kleidung.js';

const TAGE = 60;

export async function vorschlaege(env, nurEinsatz = null) {
  const { results } = await env.DB.prepare(
    `SELECT e.id AS einsatz_id, e.alarm_datum, e.alarm_uhrzeit,
            COALESCE(e.einsatzgrund, e.einsatzort, 'Einsatz') AS titel,
            pa.person_id, pe.nachname, pe.vorname,
            t.id AS teil_id, t.barcode, a.name AS artikelart
     FROM einsaetze e
     JOIN einsatz_pa pa ON pa.einsatz_id = e.id AND pa.person_id IS NOT NULL
     JOIN personen pe ON pe.id = pa.person_id
     JOIN kleidung_teile t ON t.person_id = pa.person_id AND t.im_bestand = 1
     JOIN kleidung_artikelarten a ON a.id = t.artikelart_id AND a.agt_relevant = 1
     WHERE e.alarm_datum >= date(?, '-${TAGE} days')
       AND (? IS NULL OR e.id = ?)
       AND NOT EXISTS (SELECT 1 FROM kleidung_einsatz_vorschlaege v WHERE v.einsatz_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM kleidung_reinigungen r
                       WHERE r.teil_id = t.id
                         AND (r.gereinigt_am IS NULL OR COALESCE(r.abgegeben_am, r.gereinigt_am) >= e.alarm_datum))
     ORDER BY e.alarm_datum DESC, e.id DESC, pe.nachname, a.sort_order`
  ).bind(heuteBerlin(), nurEinsatz, nurEinsatz).all();

  const je = new Map();
  for (const r of results) {
    if (!je.has(r.einsatz_id)) {
      je.set(r.einsatz_id, { einsatz_id: r.einsatz_id, datum: r.alarm_datum, uhrzeit: r.alarm_uhrzeit,
                              titel: r.titel, personen: new Map(), teile: [] });
    }
    const v = je.get(r.einsatz_id);
    v.personen.set(r.person_id, `${r.vorname} ${r.nachname}`);
    if (!v.teile.some((t) => t.id === r.teil_id)) v.teile.push({ id: r.teil_id, barcode: r.barcode, artikelart: r.artikelart });
  }
  return [...je.values()].map((v) => ({ ...v, personen: [...v.personen.values()] }));
}

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  return mitKleidung(async () => json(await vorschlaege(env)));
}

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const einsatzId = Number(body?.einsatz_id);
  if (!Number.isInteger(einsatzId)) return err('Einsatz fehlt');
  const aktion = body?.aktion;
  if (aktion !== 'uebernehmen' && aktion !== 'ignorieren') return err('Unbekannte Aktion');
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.datum || '')) ? body.datum : heuteBerlin();

  return mitKleidung(async () => {
    const [v] = await vorschlaege(env, einsatzId);
    const st = [];
    if (aktion === 'uebernehmen' && v) {
      const ins = env.DB.prepare(
        `INSERT INTO kleidung_reinigungen (teil_id, abgegeben_am, abgegeben_by) VALUES (?, ?, ?)`);
      for (const t of v.teile) st.push(ins.bind(t.id, datum, data.user.username));
    }
    st.push(env.DB.prepare(
      `INSERT OR REPLACE INTO kleidung_einsatz_vorschlaege (einsatz_id, aktion, erledigt_by) VALUES (?, ?, ?)`
    ).bind(einsatzId, aktion === 'uebernehmen' ? 'uebernommen' : 'ignoriert', data.user.username));
    st.push(auditEintrag(env, data.user, {
      bereich: 'kleidung', aktion: 'anlegen', objekt: 'einsatz-vorschlag', objektId: einsatzId,
      details: { aktion, datum, teile: v ? v.teile.map((t) => t.id) : [] },
    }));
    await env.DB.batch(st);
    return json({ ok: true, teile: aktion === 'uebernehmen' && v ? v.teile.length : 0 });
  });
}
