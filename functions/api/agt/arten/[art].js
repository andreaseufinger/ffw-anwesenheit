// PUT /api/agt/arten/:art { frist_monate?, pass_pflicht?, florix_pflicht? }
// Ändert die Gültigkeit (Monate, leer = Datum laut Bescheinigung) und welche
// Häkchen die Art für "dunkelgrün" braucht. Bei geänderter Frist werden von
// Hand eingetragene Nachweise mitgerechnet, deren Gültigkeit noch der alten
// Frist entsprach; automatische gleicht /api/agt ohnehin ab. Florix-Daten
// bleiben, wie sie importiert wurden.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../../_lib/auth.js';
import { auditEintrag } from '../../../_lib/audit.js';
import { GUELTIG_SQL } from '../../../_lib/agt.js';
import { mitAtemschutz } from '../../agt.js';

export async function onRequestPut({ request, env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }

  return mitAtemschutz(async () => {
    const alt = await env.DB.prepare(
      `SELECT art, name, frist_monate, pass_pflicht, florix_pflicht FROM agt_arten WHERE art = ?`
    ).bind(String(params.art)).first();
    if (!alt) return err('Unbekannte Tauglichkeit', 404);

    const neu = {};
    if ('frist_monate' in body) {
      if (alt.art === 'lehrgang') return err('Der Lehrgang ist unbefristet');
      const v = body.frist_monate === null || body.frist_monate === '' ? null : Number(body.frist_monate);
      if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 120)) return err('Gültigkeit: 1 bis 120 Monate oder leer');
      neu.frist_monate = v;
    }
    for (const k of ['pass_pflicht', 'florix_pflicht']) {
      if (k in body) neu[k] = body[k] ? 1 : 0;
    }
    const geaendert = Object.keys(neu).filter((k) => neu[k] !== alt[k]);
    if (!geaendert.length) return json({ ok: true, unveraendert: true });

    const st = [env.DB.prepare(
      `UPDATE agt_arten SET ${geaendert.map((k) => `${k} = ?`).join(', ')} WHERE art = ?`
    ).bind(...geaendert.map((k) => neu[k]), alt.art)];
    if (geaendert.includes('frist_monate') && alt.frist_monate && neu.frist_monate) {
      st.push(env.DB.prepare(
        `UPDATE agt_nachweise SET gueltig_bis = ${GUELTIG_SQL('datum', '?')}
         WHERE art = ? AND quelle = 'manuell' AND datum IS NOT NULL
           AND gueltig_bis = ${GUELTIG_SQL('datum', '?')}`
      ).bind(neu.frist_monate, alt.art, alt.frist_monate));
    }
    st.push(auditEintrag(env, data.user, {
      bereich: 'atemschutz', aktion: 'aendern', objekt: 'tauglichkeit', objektId: alt.art,
      details: { art: alt.art, ...Object.fromEntries(geaendert.map((k) => [k, { alt: alt[k], neu: neu[k] }])) },
    }));
    await env.DB.batch(st);
    return json({ ok: true });
  });
}
