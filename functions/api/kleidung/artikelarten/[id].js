// PUT /api/kleidung/artikelarten/:id — { name?, intervall_monate?, agt_relevant? }
import { json, err, unauthorized, forbidden, darfKleidung } from '../../../_lib/auth.js';
import { auditEintrag } from '../../../_lib/audit.js';
import { mitKleidung } from '../../kleidung.js';

export async function onRequestPut({ request, env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfKleidung(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  return mitKleidung(async () => {
    const alt = await env.DB.prepare(`SELECT * FROM kleidung_artikelarten WHERE id = ?`).bind(id).first();
    if (!alt) return err('Artikelart nicht gefunden', 404);
    const neu = {};
    if ('name' in body) {
      neu.name = String(body.name || '').trim();
      if (!neu.name) return err('Name fehlt');
    }
    if ('intervall_monate' in body) {
      const v = body.intervall_monate === null || body.intervall_monate === '' ? null : Number(body.intervall_monate);
      if (v !== null && !(Number.isInteger(v) && v > 0)) return err('Intervall ungültig');
      neu.intervall_monate = v;
    }
    if ('agt_relevant' in body) neu.agt_relevant = body.agt_relevant ? 1 : 0;
    const geaendert = Object.keys(neu).filter((k) => neu[k] !== alt[k]);
    if (!geaendert.length) return json({ ok: true, unveraendert: true });
    await env.DB.batch([
      env.DB.prepare(`UPDATE kleidung_artikelarten SET ${geaendert.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...geaendert.map((k) => neu[k]), id),
      auditEintrag(env, data.user, { bereich: 'kleidung', aktion: 'aendern', objekt: 'artikelart', objektId: id,
        details: Object.fromEntries(geaendert.map((k) => [k, { alt: alt[k], neu: neu[k] }])) }),
    ]);
    return json({ ok: true });
  });
}
