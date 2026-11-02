// PUT    /api/agt/termine/:id — Datum, Uhrzeit, Kunden oder Art ändern.
//        Geplante AGT ziehen mit, wenn sich das Datum ändert.
// DELETE /api/agt/termine/:id — Termin löschen; geplante AGT behalten das
//        Datum als frei eingegebenes Datum.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../../_lib/auth.js';
import { auditEintrag } from '../../../_lib/audit.js';
import { mitAtemschutz } from '../../agt.js';
import { terminPruefen } from '../termine.js';

async function lade(env, id) {
  return env.DB.prepare(`SELECT id, datum, uhrzeit, kunden, art FROM agt_strecke_termine WHERE id = ?`).bind(id).first();
}

export async function onRequestPut({ request, env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  return mitAtemschutz(async () => {
    const alt = await lade(env, id);
    if (!alt) return err('Termin nicht gefunden', 404);
    const neu = terminPruefen({ ...alt, ...body });
    if (neu.fehler) return err(neu.fehler);
    const doppelt = await env.DB.prepare(
      `SELECT id FROM agt_strecke_termine WHERE datum = ? AND uhrzeit IS ? AND id <> ?`
    ).bind(neu.datum, neu.uhrzeit, id).first();
    if (doppelt) return err('Diesen Termin gibt es schon');
    const geaendert = ['datum', 'uhrzeit', 'kunden', 'art'].filter((k) => neu[k] !== alt[k]);
    if (!geaendert.length) return json({ ok: true, unveraendert: true });
    const st = [env.DB.prepare(
      `UPDATE agt_strecke_termine SET ${geaendert.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
    ).bind(...geaendert.map((k) => neu[k]), id)];
    if (geaendert.includes('datum')) {
      st.push(env.DB.prepare(`UPDATE agt_planung SET datum = ? WHERE termin_id = ?`).bind(neu.datum, id));
    }
    st.push(auditEintrag(env, data.user, {
      bereich: 'atemschutz', aktion: 'aendern', objekt: 'strecke-termin', objektId: id,
      details: Object.fromEntries(geaendert.map((k) => [k, { alt: alt[k], neu: neu[k] }])),
    }));
    await env.DB.batch(st);
    return json({ ok: true });
  });
}

export async function onRequestDelete({ env, params, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  const id = Number(params.id);
  if (!Number.isInteger(id)) return err('Ungültige ID');
  return mitAtemschutz(async () => {
    const alt = await lade(env, id);
    if (!alt) return err('Termin nicht gefunden', 404);
    await env.DB.batch([
      env.DB.prepare(`UPDATE agt_planung SET termin_id = NULL WHERE termin_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM agt_strecke_termine WHERE id = ?`).bind(id),
      auditEintrag(env, data.user, {
        bereich: 'atemschutz', aktion: 'loeschen', objekt: 'strecke-termin', objektId: id, details: alt,
      }),
    ]);
    return json({ ok: true });
  });
}
