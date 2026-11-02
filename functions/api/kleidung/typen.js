// PUT /api/kleidung/typen — { typ, artikelart_id | null } Bezeichnung aus ZMS
// einer Artikelart zuordnen; null = nicht führen.
import { json, err, unauthorized, forbidden, darfKleidung } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitKleidung } from '../kleidung.js';

export async function onRequestPut({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const typ = String(body?.typ || '').trim();
  if (!typ) return err('Typ fehlt');
  const aid = body?.artikelart_id ? Number(body.artikelart_id) : null;
  return mitKleidung(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO kleidung_typen (typ, artikelart_id) VALUES (?, ?)
                      ON CONFLICT(typ) DO UPDATE SET artikelart_id = excluded.artikelart_id`).bind(typ, aid),
      // Teile dieses Typs ziehen mit
      env.DB.prepare(`UPDATE kleidung_teile SET artikelart_id = ? WHERE typ = ? COLLATE NOCASE AND quelle = 'zms'`).bind(aid, typ),
      auditEintrag(env, data.user, { bereich: 'kleidung', aktion: 'aendern', objekt: 'typ', objektId: typ, details: { artikelart_id: aid } }),
    ]);
    return json({ ok: true });
  });
}
