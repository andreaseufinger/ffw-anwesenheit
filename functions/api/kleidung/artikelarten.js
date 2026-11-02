// GET  /api/kleidung/artikelarten — Artikelliste mit Prüfintervall und
//      Merkmal "zählt für AGT-Kleidung", dazu die ZMS-Typen je Art.
// POST /api/kleidung/artikelarten — neue Artikelart { name, intervall_monate?, agt_relevant? }
import { json, err, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitKleidung } from '../kleidung.js';

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  return mitKleidung(async () => {
    const [arten, typen] = await Promise.all([
      env.DB.prepare(
        `SELECT a.id, a.name, a.intervall_monate, a.agt_relevant, a.sort_order,
                (SELECT COUNT(*) FROM kleidung_teile t WHERE t.artikelart_id = a.id AND t.im_bestand = 1) AS teile
         FROM kleidung_artikelarten a ORDER BY a.sort_order, a.name`
      ).all(),
      env.DB.prepare(`SELECT typ, artikelart_id FROM kleidung_typen ORDER BY typ COLLATE NOCASE`).all(),
    ]);
    return json({ artikelarten: arten.results, typen: typen.results });
  });
}

export async function onRequestPost({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const name = String(body?.name || '').trim();
  if (!name) return err('Name fehlt');
  const intervall = body?.intervall_monate === null || body?.intervall_monate === '' ? null
    : Number(body?.intervall_monate ?? 12);
  if (intervall !== null && !(Number.isInteger(intervall) && intervall > 0)) return err('Intervall ungültig');
  return mitKleidung(async () => {
    const r = await env.DB.prepare(
      `INSERT INTO kleidung_artikelarten (name, intervall_monate, agt_relevant, sort_order)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM kleidung_artikelarten))`
    ).bind(name, intervall, body?.agt_relevant ? 1 : 0).run().catch((e) => {
      if (/UNIQUE/i.test(String(e?.message))) return null;
      throw e;
    });
    if (!r) return err('Diese Artikelart gibt es schon', 409);
    await auditEintrag(env, data.user, { bereich: 'kleidung', aktion: 'anlegen', objekt: 'artikelart',
      objektId: r.meta.last_row_id, details: { name, intervall_monate: intervall } }).run();
    return json({ id: r.meta.last_row_id }, { status: 201 });
  });
}
