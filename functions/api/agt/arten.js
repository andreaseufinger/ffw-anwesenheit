// GET /api/agt/arten — die Tauglichkeiten (Nachweisarten) mit Gültigkeit in
// Monaten und den Häkchen, die für "dunkelgrün" nötig sind.
import { json, unauthorized, forbidden, darfAtemschutz } from '../../_lib/auth.js';
import { mitAtemschutz } from '../agt.js';

export async function onRequestGet({ env, data }) {
  if (!data.user) return unauthorized();
  if (!darfAtemschutz(data.user)) return forbidden();
  return mitAtemschutz(async () => {
    const { results } = await env.DB.prepare(
      `SELECT art, name, gruppe, frist_monate, pass_pflicht, florix_pflicht FROM agt_arten ORDER BY sort_order`
    ).all();
    return json(results);
  });
}
