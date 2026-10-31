// Korrektur einzelner Reinigungen (Fehleingaben).
// DELETE /api/kleidung/reinigung/:id — Eintrag austragen (Abgabe und
//        Reinigung werden gelöscht).
// PUT    /api/kleidung/reinigung/:id { gereinigt: false } — "gereinigt"
//        zurücknehmen; das Teil ist wieder in der Reinigung. Nur bei
//        Einträgen mit Abgabe, sonst bliebe ein leerer Eintrag stehen.
import { json, err, unauthorized, forbidden, darfKleidung } from '../../../_lib/auth.js';
import { auditEintrag } from '../../../_lib/audit.js';
import { mitKleidung } from '../../kleidung.js';

async function lade(env, id) {
  return env.DB.prepare(
    `SELECT r.id, r.teil_id, r.abgegeben_am, r.gereinigt_am, t.barcode
     FROM kleidung_reinigungen r JOIN kleidung_teile t ON t.id = r.teil_id WHERE r.id = ?`
  ).bind(id).first();
}

export async function onRequestDelete({ env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');
  return mitKleidung(async () => {
    const r = await lade(env, id);
    if (!r) return err('Eintrag nicht gefunden', 404);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM kleidung_reinigungen WHERE id = ?`).bind(id),
      auditEintrag(env, data.user, {
        bereich: 'kleidung', aktion: 'loeschen', objekt: 'reinigung', objektId: id,
        details: { teil_id: r.teil_id, barcode: r.barcode, abgegeben_am: r.abgegeben_am, gereinigt_am: r.gereinigt_am },
      }),
    ]);
    return json({ ok: true });
  });
}

export async function onRequestPut({ request, env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  if (body?.gereinigt !== false) return err('Nur "gereinigt: false" wird unterstützt');
  return mitKleidung(async () => {
    const r = await lade(env, id);
    if (!r) return err('Eintrag nicht gefunden', 404);
    if (!r.gereinigt_am) return json({ ok: true, unveraendert: true });
    if (!r.abgegeben_am) return err('Nachgetragene Reinigung ohne Abgabe: bitte austragen');
    const offen = await env.DB.prepare(
      `SELECT id FROM kleidung_reinigungen WHERE teil_id = ? AND gereinigt_am IS NULL AND id <> ?`
    ).bind(r.teil_id, id).first();
    if (offen) return err('Das Teil ist bereits wieder in der Reinigung');
    await env.DB.batch([
      env.DB.prepare(`UPDATE kleidung_reinigungen SET gereinigt_am = NULL, gereinigt_by = NULL WHERE id = ?`).bind(id),
      auditEintrag(env, data.user, {
        bereich: 'kleidung', aktion: 'aendern', objekt: 'reinigung', objektId: id,
        details: { teil_id: r.teil_id, barcode: r.barcode, gereinigt_am: { alt: r.gereinigt_am, neu: null } },
      }),
    ]);
    return json({ ok: true });
  });
}
