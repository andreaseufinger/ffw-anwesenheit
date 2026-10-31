// POST /api/kleidung/teile — Teil erfassen, das noch nicht in ZMS-Hessen
// steht. Pflicht ist eine Inventarnummer der Gemeinde (BRE…), damit Scan und
// späterer Abgleich mit ZMS funktionieren.
// Body: { barcode, artikelart_id, groesse?, person_id? }
import { json, err, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitKleidung } from '../kleidung.js';
import { codeNormalisieren } from './teil.js';

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const barcode = codeNormalisieren(body?.barcode);
  if (!/^BRE\d+$/.test(barcode)) return err('Inventarnummer der Gemeinde (BRE…) fehlt');
  const artikelartId = Number(body?.artikelart_id);
  if (!Number.isInteger(artikelartId)) return err('Artikelart fehlt');
  const personId = body?.person_id ? Number(body.person_id) : null;
  const groesse = String(body?.groesse || '').trim() || null;

  return mitKleidung(async () => {
    const vorhanden = await env.DB.prepare(`SELECT id FROM kleidung_teile WHERE barcode = ? COLLATE NOCASE`).bind(barcode).first();
    if (vorhanden) return err('Diese Inventarnummer ist schon erfasst', 409);
    const res = await env.DB.prepare(
      `INSERT INTO kleidung_teile (barcode, artikelart_id, groesse, person_id, quelle, created_by)
       VALUES (?, ?, ?, ?, 'app', ?)`
    ).bind(barcode, artikelartId, groesse, personId, data.user.username).run();
    const id = res.meta.last_row_id;
    await auditEintrag(env, data.user, {
      bereich: 'kleidung', aktion: 'anlegen', objekt: 'teil', objektId: id,
      details: { barcode, artikelart_id: artikelartId, groesse, person_id: personId },
    }).run();
    return json({ id }, { status: 201 });
  });
}
