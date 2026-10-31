// GET    /api/kleidung/teile/:id — Teil mit allen Reinigungen
// PUT    /api/kleidung/teile/:id — nur Teile "nur in der App": Person, Größe,
//        Artikelart. Teile aus ZMS werden in ZMS umgebucht und kommen mit dem
//        nächsten Import.
// DELETE /api/kleidung/teile/:id — nur Teile "nur in der App".
import { json, err, unauthorized, forbidden, darfKleidung } from '../../../_lib/auth.js';
import { auditEintrag } from '../../../_lib/audit.js';
import { heuteBerlin } from '../../../_lib/agt.js';
import { TEILE_SQL, teilAufbereiten, mitKleidung } from '../../kleidung.js';

function idAus(params) { const id = Number(params.id); return Number.isInteger(id) ? id : null; }

export async function onRequestGet({ env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  const id = idAus(params); if (!id) return err('Ungültige ID');
  return mitKleidung(async () => {
    const t = await env.DB.prepare(`${TEILE_SQL} WHERE t.id = ?`).bind(id).first();
    if (!t) return err('Teil nicht gefunden', 404);
    const { results } = await env.DB.prepare(
      `SELECT id, abgegeben_am, gereinigt_am, abgegeben_by, gereinigt_by FROM kleidung_reinigungen
       WHERE teil_id = ? ORDER BY COALESCE(gereinigt_am, abgegeben_am) DESC, id DESC`
    ).bind(id).all();
    return json({ ...teilAufbereiten(t, heuteBerlin()), reinigungen: results });
  });
}

export async function onRequestPut({ request, env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  const id = idAus(params); if (!id) return err('Ungültige ID');
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  return mitKleidung(async () => {
    const alt = await env.DB.prepare(`SELECT * FROM kleidung_teile WHERE id = ?`).bind(id).first();
    if (!alt) return err('Teil nicht gefunden', 404);
    if (alt.quelle !== 'app') return err('Teile aus ZMS-Hessen werden dort geändert und kommen mit dem nächsten Import');
    const neu = {};
    if ('person_id' in body) neu.person_id = body.person_id ? Number(body.person_id) : null;
    if ('groesse' in body) neu.groesse = String(body.groesse || '').trim() || null;
    if ('artikelart_id' in body) neu.artikelart_id = Number(body.artikelart_id) || null;
    const geaendert = Object.keys(neu).filter((k) => neu[k] !== alt[k]);
    if (!geaendert.length) return json({ ok: true, unveraendert: true });
    await env.DB.batch([
      env.DB.prepare(`UPDATE kleidung_teile SET ${geaendert.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...geaendert.map((k) => neu[k]), id),
      auditEintrag(env, data.user, {
        bereich: 'kleidung', aktion: 'aendern', objekt: 'teil', objektId: id,
        details: Object.fromEntries(geaendert.map((k) => [k, { alt: alt[k], neu: neu[k] }])),
      }),
    ]);
    return json({ ok: true });
  });
}

export async function onRequestDelete({ env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  const id = idAus(params); if (!id) return err('Ungültige ID');
  return mitKleidung(async () => {
    const alt = await env.DB.prepare(`SELECT * FROM kleidung_teile WHERE id = ?`).bind(id).first();
    if (!alt) return err('Teil nicht gefunden', 404);
    if (alt.quelle !== 'app') return err('Teile aus ZMS-Hessen lassen sich hier nicht löschen');
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM kleidung_teile WHERE id = ?`).bind(id),
      auditEintrag(env, data.user, {
        bereich: 'kleidung', aktion: 'loeschen', objekt: 'teil', objektId: id,
        details: { barcode: alt.barcode, person_id: alt.person_id },
      }),
    ]);
    return json({ ok: true });
  });
}
