// PUT /api/agt/planung — nächsten Streckendurchgang planen.
// Body: { person_ids: [..], datum: 'JJJJ-MM-TT' | null, termin_id?: n | null }
// datum null leert die Planung. Mit termin_id gilt dessen Datum.
import { json, err, unauthorized, forbidden, darfAtemschutz } from '../../_lib/auth.js';
import { auditEintrag } from '../../_lib/audit.js';
import { mitAtemschutz } from '../agt.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestPut({ request, env, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  let body;
  try { body = await request.json(); } catch { return err('Ungültiges JSON'); }
  const ids = [...new Set((Array.isArray(body?.person_ids) ? body.person_ids : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return err('Keine Person gewählt');

  return mitAtemschutz(async () => {
    let datum = body?.datum ? String(body.datum) : null;
    let terminId = body?.termin_id ? Number(body.termin_id) : null;
    if (terminId) {
      const t = await env.DB.prepare(`SELECT id, datum FROM agt_strecke_termine WHERE id = ?`).bind(terminId).first();
      if (!t) return err('Termin nicht gefunden', 404);
      datum = t.datum;
    }
    if (datum && !ISO.test(datum)) return err('Datum ungültig');

    const agt = await env.DB.prepare(
      `SELECT id FROM personen WHERE agt = 1 AND id IN (${ids.map(() => '?').join(', ')})`
    ).bind(...ids).all();
    if (agt.results.length !== ids.length) return err('Nur Personen mit AGT-Kennzeichen');

    const st = ids.map((id) => datum
      ? env.DB.prepare(
          `INSERT INTO agt_planung (person_id, datum, termin_id, geplant_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(person_id) DO UPDATE SET datum = excluded.datum, termin_id = excluded.termin_id,
             geplant_by = excluded.geplant_by, geplant_at = CURRENT_TIMESTAMP`
        ).bind(id, datum, terminId, data.user.username)
      : env.DB.prepare(`DELETE FROM agt_planung WHERE person_id = ?`).bind(id));
    st.push(auditEintrag(env, data.user, {
      bereich: 'atemschutz', aktion: datum ? 'aendern' : 'loeschen', objekt: 'strecke-planung',
      details: { person_ids: ids, datum, termin_id: terminId },
    }));
    await env.DB.batch(st);
    return json({ ok: true, datum });
  });
}
