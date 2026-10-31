// POST /api/kleidung/reinigung — Teile zur Reinigung geben oder als
// gereinigt zurückmelden. Die Reinigung ist zugleich die Prüfung.
//
// Body: { aktion: 'abgeben' | 'zurueck' | 'rueckgaengig', ids: [teil_id], datum,
//         eintraege?: [{ id, art }] }
// - abgeben: neue offene Abgabe; schon abgegebene Teile werden übersprungen.
// - zurueck: schließt die offene Abgabe mit dem Datum; ohne offene Abgabe
//   wird eine Reinigung nachgetragen (z. B. bisherige Daten erfassen).
// - rueckgaengig: macht die zurückgegebenen eintraege ungeschehen
//   (art 'neu' = Zeile löschen, art 'geschlossen' = wieder offen).
import { json, err, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitKleidung } from '../kleidung.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const aktion = body?.aktion;
  const wer = data.user.username;

  return mitKleidung(async () => {
    if (aktion === 'rueckgaengig') {
      const eintraege = Array.isArray(body?.eintraege) ? body.eintraege : [];
      const st = [];
      for (const e of eintraege) {
        const id = Number(e?.id);
        if (!Number.isInteger(id)) continue;
        if (e.art === 'neu') st.push(env.DB.prepare(`DELETE FROM kleidung_reinigungen WHERE id = ?`).bind(id));
        else if (e.art === 'geschlossen') st.push(env.DB.prepare(
          `UPDATE kleidung_reinigungen SET gereinigt_am = NULL, gereinigt_by = NULL WHERE id = ?`).bind(id));
      }
      if (!st.length) return err('Nichts rückgängig zu machen');
      st.push(auditEintrag(env, data.user, { bereich: 'kleidung', aktion: 'aendern', objekt: 'reinigung', details: { rueckgaengig: eintraege } }));
      await env.DB.batch(st);
      return json({ ok: true });
    }

    const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(Number).filter(Number.isInteger))];
    if (!ids.length) return err('Keine Teile gewählt');
    const datum = String(body?.datum || '');
    if (!ISO.test(datum)) return err('Datum fehlt oder ungültig');
    if (aktion !== 'abgeben' && aktion !== 'zurueck') return err('Unbekannte Aktion');

    const offen = await env.DB.prepare(
      `SELECT id, teil_id FROM kleidung_reinigungen
       WHERE gereinigt_am IS NULL AND teil_id IN (${ids.map(() => '?').join(', ')})`
    ).bind(...ids).all();
    const offenJeTeil = new Map(offen.results.map((r) => [r.teil_id, r.id]));
    const ergebnis = [];   // { teil_id, id, art } für Rückgängig
    const uebersprungen = [];

    for (const tid of ids) {
      if (aktion === 'abgeben') {
        if (offenJeTeil.has(tid)) { uebersprungen.push(tid); continue; }
        const r = await env.DB.prepare(
          `INSERT INTO kleidung_reinigungen (teil_id, abgegeben_am, abgegeben_by) VALUES (?, ?, ?)`
        ).bind(tid, datum, wer).run();
        ergebnis.push({ teil_id: tid, id: r.meta.last_row_id, art: 'neu' });
      } else if (offenJeTeil.has(tid)) {
        const rid = offenJeTeil.get(tid);
        await env.DB.prepare(
          `UPDATE kleidung_reinigungen SET gereinigt_am = ?, gereinigt_by = ? WHERE id = ?`
        ).bind(datum, wer, rid).run();
        ergebnis.push({ teil_id: tid, id: rid, art: 'geschlossen' });
      } else {
        const r = await env.DB.prepare(
          `INSERT INTO kleidung_reinigungen (teil_id, gereinigt_am, gereinigt_by) VALUES (?, ?, ?)`
        ).bind(tid, datum, wer).run();
        ergebnis.push({ teil_id: tid, id: r.meta.last_row_id, art: 'neu' });
      }
    }
    await auditEintrag(env, data.user, {
      bereich: 'kleidung', aktion: 'anlegen', objekt: 'reinigung',
      details: { aktion, datum, teile: ergebnis.map((e) => e.teil_id), uebersprungen },
    }).run();
    return json({ ok: true, eintraege: ergebnis, uebersprungen });
  });
}
